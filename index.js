// index.js
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

let currentSock = null; // referência global para reconectar/enviar

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // vamos imprimir manualmente
    browser: ["PedidosDaSorte", "Desktop", "1.0.0"],
  });

  currentSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Escaneie este QR Code com o WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      try {
        await sock.sendMessage("5511991249136@s.whatsapp.net", {
          text: "Mensagem enviada automaticamente ao conectar ✅",
        });
      } catch (err) {
        console.error("Erro ao enviar mensagem de boas-vindas:", err);
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("❌ Conexão fechada.", { statusCode, shouldReconnect });

      if (shouldReconnect) {
        // backoff simples para não recursar loucamente
        await delay(2000);
        return startBot();
      } else {
        console.log("Sessão encerrada (loggedOut). Apague ./auth_info_baileys para reautenticar.");
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const { type, messages } = m;
    if (type !== "notify" || !messages || !messages.length) return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;

    // captura texto de várias fontes
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.buttonsResponseMessage?.selectedButtonId ||
      msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      "";

    console.log(`📩 Mensagem recebida de ${sender}: ${text}`);

    if (text.trim().toLowerCase() === "oi") {
      await sock.sendMessage(sender, { text: "Olá! Tudo certo? 🤖" });
    }
  });

  // função global para você usar em outros módulos
  global.sendMessage = async (number, text) => {
    const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
    if (!currentSock) throw new Error("Socket não conectado.");
    return currentSock.sendMessage(jid, { text });
  };
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

startBot().catch((err) => {
  console.error("Falha ao iniciar o bot:", err);
  process.exit(1);
});

// higiene opcional de erros não tratados
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
