// --- MULTI-TENANT WA MANAGER ---
const sessionsBaseDir = process.env.SESSIONS_BASE_DIR || './sessions';
const path = require('path');
const fs = require("fs")
if (!fs.existsSync(sessionsBaseDir)) fs.mkdirSync(sessionsBaseDir, { recursive: true });

const waPool = new Map(); // tenantId -> { sock, connected, connecting }

async function ensureTenantSocket(tenantId) {
  let entry = waPool.get(tenantId);
  if (entry?.connected) return entry;

  if (entry?.connecting) {
    await waitUntil(() => waPool.get(tenantId)?.connected, 90_000);
    return waPool.get(tenantId);
  }

  entry = { sock: null, connected: false, connecting: true };
  waPool.set(tenantId, entry);

  const dir = path.join(sessionsBaseDir, sanitize(tenantId));
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["PedidosDaSorte", tenantId, "1.0.0"],
  });

  entry.sock = sock;

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`[${tenantId}] QR gerado — use Dispositivos vinculados para autenticar.`);
      qrcodeTerm.generate(qr, { small: false });
    }
    if (connection === "open") {
      entry.connected = true;
      entry.connecting = false;
      console.log(`[${tenantId}] ✅ conectado`);
    }
    if (connection === "close") {
      entry.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[${tenantId}] ❌ conexão fechada`, { code, shouldReconnect });
      if (code === DisconnectReason.loggedOut) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        waPool.delete(tenantId);
        return;
      }
      entry.connecting = false;
      if (shouldReconnect) {
        setTimeout(() => ensureTenantSocket(tenantId).catch(console.error), 2000);
      }
    }
  });

  // espera abrir ou mostrar QR
  try {
    await waitUntil(() => waPool.get(tenantId)?.connected, 30_000);
  } catch (_e) {
    // ok se só gerou QR; segue com entry.connecting=false
  } finally {
    entry.connecting = false;
  }

  return entry;
}

function sanitize(s) { return String(s).replace(/[^a-zA-Z0-9_\-./]/g, "_"); }
function waitUntil(cond, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error("timeout")); }
    }, 200);
  });
}
