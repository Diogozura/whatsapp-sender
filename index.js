const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const fs = require("fs");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    "./auth_info_baileys"
  );

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Mostra o QR no terminal
      console.log("\n📱 Escaneie este QR Code com o WhatsApp:\n");
      require("qrcode-terminal").generate(qr, { small: true });
    }

    const error = lastDisconnect?.error;
    const shouldReconnect =
      error?.output?.statusCode !== DisconnectReason.loggedOut;

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      sock.sendMessage("5511991249136@s.whatsapp.net", {
        text: "Mensagem enviada automaticamente ao conectar ✅",
      });
    }
    if (connection === "close") {
      console.log("❌ Conexão fechada. Reconectando?", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text;
    console.log(`📩 Mensagem recebida de ${sender}: ${text}`);
    if (text?.toLowerCase() === "oi") {
      await sock.sendMessage(sender, { text: "Olá! Tudo certo? 🤖" });
    }
  });

  global.sendMessage = async (number, text) => {
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
  };
}

startBot();
