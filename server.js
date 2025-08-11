// server.js (CommonJS, prod-ready)

require("dotenv").config();

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const helmet = require("helmet");
const qrcodeTerm = require("qrcode-terminal");
const fs = require("fs");
const crypto = require("crypto");

// === se você já criou o waManager.js, mantenha esse require:
const { ensureTenantSocket } = require("./waManager");
// se ainda não criou, comente a linha acima e crie o arquivo conforme combinamos.

// === Firebase Admin + middlewares de auth (mantenha aqui ou troque por seus requires)
const admin = require("./firebaseAdmin");

// autentica Firebase (ID Token)
async function authFirebase(req, res, next) {
  const auth = req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "unauthorized" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (e) {
    return res.status(401).json({ error: "invalid_token" });
  }
}

// carrega tenant do Firestore + valida acesso do usuário
async function loadTenantAndAuthorize(req, res, next) {
  const tenantId = req.params.tenantId;
  if (!tenantId) return res.status(400).json({ error: "tenant_required" });

  try {
    const tSnap = await admin.firestore().collection("tenants").doc(tenantId).get();
    if (!tSnap.exists) return res.status(404).json({ error: "tenant_not_found" });
    const tenant = tSnap.data();
    if (tenant.active === false) return res.status(403).json({ error: "tenant_inactive" });

    const uSnap = await admin.firestore().collection("users").doc(req.user.uid).get();
    const uData = uSnap.exists ? uSnap.data() : null;
    const allowed = Array.isArray(uData?.tenants) && uData.tenants.includes(tenantId);
    if (!allowed) return res.status(403).json({ error: "forbidden_tenant" });

    // overrides de limites por tenant
    req.tenant = {
      id: tenantId,
      bulkMax: tenant.bulkMax ?? BULK_MAX,
      bulkConcurrency: tenant.bulkConcurrency ?? BULK_CONCURRENCY,
      bulkDelayMs: tenant.bulkDelayMs ?? BULK_DELAY_MS,
    };
    next();
  } catch (e) {
    console.error("loadTenantAndAuthorize error", e);
    return res.status(500).json({ error: "tenant_lookup_failed" });
  }
}

/* ====================== ENV & CONFIG ====================== */

const REQUIRED_ENV = ["SESSION_DIR", "API_KEY", "CORS_ORIGINS"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Variável de ambiente obrigatória faltando: ${key}`);
    process.exit(1);
  }
}

const SESSION_DIR = process.env.SESSION_DIR;
const API_KEY = process.env.API_KEY;

// múltiplas origens, separadas por vírgula (sem barra final)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";

const BULK_MAX = Math.max(1, parseInt(process.env.BULK_MAX || "200", 10));
const BULK_CONCURRENCY = Math.max(1, parseInt(process.env.BULK_CONCURRENCY || "3", 10));
const BULK_DELAY_MS = Math.max(0, parseInt(process.env.BULK_DELAY_MS || "800", 10));
const MAX_MSG = Math.max(50, parseInt(process.env.MAX_MSG || "1000", 10)); // limite de caracteres

/* ====================== UTILS ====================== */

function normalizeToJid(number) {
  if (!number) return "";
  if (number.includes("@")) return number;
  const digits = String(number).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}
function isLikelyBrazilNumber(number) {
  const digits = String(number).replace(/\D/g, "");
  return /^55\d{10,11}$/.test(digits);
}
function delay(ms) { return new Promise((res) => setTimeout(res, ms)); }
function renderTemplate(tpl, vars = {}) {
  if (!tpl) return "";
  let out = tpl.replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ""));
  return out;
}
function hasPlaceholders(str = "") { return /\$\{\w+\}/.test(str) || /\{\{\w+\}\}/.test(str); }
function safeEqual(a = "", b = "") {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/* ====================== EXPRESS APP (INICIALIZE ANTES DAS ROTAS!) ====================== */

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(helmet());

// CORS restrito
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // Postman/curl
      return CORS_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("Not allowed"), false);
    },
    credentials: false,
  })
);

// Rate limit por IP
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Auth: **apenas Bearer** (sua API_KEY para rotas single-tenant)
app.use((req, res, next) => {
  // Obs: as rotas multi-tenant usam Firebase (authFirebase). Este Bearer é para as demais rotas.
  const auth = req.header("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || !safeEqual(bearer, API_KEY)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

/* ====================== ROTAS MULTI-TENANT (via ensureTenantSocket) ====================== */

// Status do tenant
app.get("/tenants/:tenantId/status", authFirebase, loadTenantAndAuthorize, async (req, res) => {
  try {
    const entry = await ensureTenantSocket(req.tenant.id);
    return res.json({ ok: true, connected: !!entry?.connected });
  } catch {
    return res.status(500).json({ ok: false, error: "status_failed" });
  }
});

// Enviar 1 por tenant
app.post("/tenants/:tenantId/send", authFirebase, loadTenantAndAuthorize, async (req, res) => {
  try {
    const { number, message } = req.body || {};
    if (!number || !message || typeof message !== "string" || message.length === 0 || message.length > MAX_MSG) {
      return res.status(400).json({ ok: false, error: "payload_invalido" });
    }
    const entry = await ensureTenantSocket(req.tenant.id);
    if (!entry?.connected || !entry?.sock) return res.status(503).json({ ok: false, error: "not_connected" });

    const digits = String(number).replace(/\D/g, "");
    if (!/^55\d{10,11}$/.test(digits)) return res.status(400).json({ ok: false, error: "numero_invalido" });

    await entry.sock.sendMessage(`${digits}@s.whatsapp.net`, { text: message });
    return res.json({ ok: true });
  } catch (e) {
    console.error(`[${req.tenant.id}] /send`, e);
    return res.status(500).json({ ok: false, error: "send_failed" });
  }
});

// Enviar múltiplos por tenant
app.post("/tenants/:tenantId/send-bulk-map", authFirebase, loadTenantAndAuthorize, async (req, res) => {
  try {
    const entry = await ensureTenantSocket(req.tenant.id);
    if (!entry?.connected || !entry?.sock) return res.status(503).json({ ok: false, error: "not_connected" });

    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items_obrigatorio" });
    }

    const clean = items
      .map((it) => ({
        number: String(it?.number ?? "").replace(/\D/g, ""),
        message: it?.message ?? "",
        template: it?.template ?? "",
        vars: it?.vars || {},
      }))
      .filter((it) => it.number.length > 0)
      .slice(0, req.tenant.bulkMax);

    if (clean.length === 0) return res.status(400).json({ ok: false, error: "nenhum_item_valido" });

    const results = new Array(clean.length);
    let idx = 0;
    const conc = Math.max(1, Math.min(req.tenant.bulkConcurrency, 10));

    async function worker() {
      while (idx < clean.length) {
        const i = idx++;
        const it = clean[i];
        if (!/^55\d{10,11}$/.test(it.number)) { results[i] = { number: it.number, ok:false, error:"numero_invalido" }; continue; }

        let text = it.message && it.message.trim()
          ? (hasPlaceholders(it.message) ? renderTemplate(it.message, it.vars) : it.message)
          : renderTemplate(it.template || "", it.vars);

        if (!text || text.length > MAX_MSG) { results[i] = { number: it.number, ok:false, error:"mensagem_invalida" }; continue; }

        try {
          await delay(req.tenant.bulkDelayMs);
          await entry.sock.sendMessage(`${it.number}@s.whatsapp.net`, { text });
          results[i] = { number: it.number, ok: true };
        } catch (e) {
          console.error(`[${req.tenant.id}] send idx=${i} ${it.number}`, e?.message || e);
          results[i] = { number: it.number, ok:false, error:"send_failed" };
        }
      }
    }

    await Promise.all(Array.from({ length: conc }, () => worker()));
    const sent = results.filter(r => r?.ok).length;
    return res.json({ ok:true, sent, total: clean.length, results });
  } catch (e) {
    console.error(`[${req.tenant.id}] /send-bulk-map`, e);
    return res.status(500).json({ ok:false, error:"bulk_map_failed" });
  }
});

/* ====================== (OPCIONAL) ROTAS SINGLE-TENANT EXISTENTES ====================== */
/* Se você ainda precisa manter /status e /send globais usando a sessão única do SESSION_DIR,
   deixe este bloco. Se não, pode remover toda a seção single-tenant. */

let currentSock = null;
let connected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["PedidosDaSorte", "Server", "1.0.0"],
  });

  currentSock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 Escaneie este QR Code com o WhatsApp:\n");
      qrcodeTerm.generate(qr, { small: false });
    }
    if (connection === "open") {
      connected = true;
      console.log("✅ Conectado ao WhatsApp!");
    }
    if (connection === "close") {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("❌ Conexão fechada.", { statusCode, shouldReconnect });

      if (statusCode === DisconnectReason.loggedOut) {
        try {
          if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            console.log("🧹 Sessão limpa. Rode de novo para reautenticar.");
          }
        } catch (e) {
          console.error("Erro ao limpar sessão:", e);
        }
        return; // não reconecta
      }
      if (shouldReconnect) {
        await delay(2000);
        return startBot();
      }
    }
  });

  // logs simples de mensagens recebidas (opcional)
  sock.ev.on("messages.upsert", async (m) => {
    const { type, messages } = m;
    if (type !== "notify" || !messages || !messages.length) return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.buttonsResponseMessage?.selectedButtonId ||
      msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      "";
    console.log(`📩 ${sender}: ${text}`);
  });
}

// Health single-tenant
app.get("/status", (_req, res) => {
  return res.json({ ok: true, connected });
});

// Enviar single-tenant
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body || {};
    if (!number || !message) {
      return res.status(400).json({ ok: false, error: "number e message são obrigatórios" });
    }
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_MSG) {
      return res.status(400).json({ ok: false, error: "mensagem_invalida" });
    }
    if (!connected || !currentSock) {
      return res.status(503).json({ ok: false, error: "not_connected" });
    }

    const digits = String(number).replace(/\D/g, "");
    if (!isLikelyBrazilNumber(digits)) {
      return res.status(400).json({ ok: false, error: "numero_invalido" });
    }

    await currentSock.sendMessage(normalizeToJid(digits), { text: message });
    return res.json({ ok: true });
  } catch (e) {
    console.error("Erro no /send:", e);
    return res.status(500).json({ ok: false, error: "send_failed" });
  }
});

/* -------- Error handler p/ CORS e gerais -------- */
app.use((err, _req, res, _next) => {
  if (err && err.message === "Not allowed") {
    return res.status(403).json({ error: "forbidden_origin" });
  }
  return res.status(500).json({ error: "internal" });
});

/* ====================== START ====================== */

app.listen(PORT, HOST, async () => {
  console.log(`🚀 WhatsApp API rodando em http://${HOST}:${PORT}`);
  try {
    // inicia a sessão single-tenant (se você ainda usa /status e /send globais)
    await startBot();
  } catch (err) {
    console.error("Falha ao iniciar o bot:", err);
  }
});
