// server.js (CommonJS)
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const express = require("express");
const qrcodeTerm = require("qrcode-terminal");
// opcional (se quiser salvar o PNG de QR):
// const QR = require("qrcode");
const fs = require("fs");
const path = require("path");

const SESSION_DIR = "./auth_info_baileys";
let currentSock = null;
let connected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["PedidosDaSorte", "Desktop", "1.0.0"],
  });

  currentSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Escaneie este QR Code com o WhatsApp:\n");
      qrcodeTerm.generate(qr, { small: false });

      // opcional: salvar PNG grande
      // try {
      //   await QR.toFile("./qr.png", qr, { width: 512, margin: 2 });
      //   console.log("🖼️ QR salvo em ./qr.png");
      // } catch (e) { console.error("Erro ao salvar PNG do QR:", e); }
    }

    if (connection === "open") {
      connected = true;
      console.log("✅ Conectado ao WhatsApp!");
    }

    if (connection === "close") {
      connected = false;
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("❌ Conexão fechada.", { statusCode, shouldReconnect });

      if (statusCode === DisconnectReason.loggedOut) {
        // sessão inválida → limpa credenciais para forçar reautenticação
        try {
          if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            console.log("🧹 Sessão limpa. Rode o servidor para gerar novo QR.");
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
    if (text.trim().toLowerCase() === "oi") {
      await sock.sendMessage(sender, { text: "Olá! Tudo certo? 🤖" });
    }
  });
}

function normalizeToJid(number) {
  if (number.includes("@")) return number;
  const digits = String(number).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/* ------------------- API ------------------- */
const app = express();
app.use(express.json());

// opcional: proteja com API key
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.header("x-api-key");
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  return next();
});

// health
app.get("/status", (_req, res) => {
  return res.json({ ok: true, connected });
});

// (opcional) servir o PNG do QR se você habilitou salvar o qr.png
app.get("/qr.png", (req, res) => {
  const file = path.resolve("./qr.png");
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.status(404).send("QR ainda não gerado.");
});

// enviar texto
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body || {};
    if (!number || !message) {
      return res.status(400).json({ ok: false, error: "number e message são obrigatórios" });
    }
    if (!connected || !currentSock) {
      return res.status(503).json({ ok: false, error: "not_connected" });
    }

    const jid = normalizeToJid(number);
    await currentSock.sendMessage(jid, { text: message });
    return res.json({ ok: true });
  } catch (e) {
    console.error("Erro no /send:", e);
    return res.status(500).json({ ok: false, error: "send_failed" });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, async () => {
  console.log(`🚀 WhatsApp API rodando em http://localhost:${PORT}`);
  try {
    await startBot();
  } catch (err) {
    console.error("Falha ao iniciar o bot:", err);
  }
});
