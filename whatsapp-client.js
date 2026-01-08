// whatsapp-client.js
const baileys = require("baileys");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  delay,
} = baileys;

const pino = require("pino");
const { Boom } = require("@hapi/boom");

let sock;

const contacts = {};
const groups = {};

// v7 RC: makeInMemoryStore bisa tidak tersedia tergantung build/entrypoint.
// Jadi buat fallback agar aplikasi tetap jalan.
const makeInMemoryStore =
  typeof baileys.makeInMemoryStore === "function" ? baileys.makeInMemoryStore : null;

const store = makeInMemoryStore
  ? makeInMemoryStore({ logger: pino({ level: "silent" }) })
  : null;

let waState = {
  status: "initializing",
  qr: null,
  connection: null,
};

let reconnecting = false;

async function initializeWhatsApp(io) {
  const { state, saveCreds } = await useMultiFileAuthState("sessions");

  sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false, // Kita handle QR di frontend
    auth: state,
    browser: ["Pegawai", "Chrome", "1.0.0"],
    // Hindari hardcode version di v7 RC (rawan break saat WA update)
  });

  // Bind store jika tersedia
  if (store) {
    store.bind(sock.ev);
  }

  const refreshCachesFromStore = () => {
    if (!store) return;

    // contacts
    if (store.contacts) {
      Object.assign(contacts, store.contacts);
    }
    // groups (tergantung versi, store.groupMetadata bisa ada/tidak)
    if (store.groupMetadata) {
      Object.assign(groups, store.groupMetadata);
    }
  };

  sock.ev.on("contacts.set", (update) => {
    Object.assign(contacts, {});
    for (const contact of update.contacts || []) {
      if (contact?.id) contacts[contact.id] = contact;
    }
    console.log("Kontak berhasil dimuat/di-set ulang.");
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const update of updates || []) {
      if (!update?.id) continue;
      if (contacts[update.id]) Object.assign(contacts[update.id], update);
      else contacts[update.id] = update;
    }
    console.log("Kontak diperbarui.");
  });

  // Listener untuk event koneksi
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    waState.connection = connection;
    refreshCachesFromStore();

    if (qr) {
      console.log("QR Code generated");
      waState.status = "qr_received";
      waState.qr = qr;
      io.emit("qr", qr);
      io.emit("status", "Silakan pindai QR code untuk terhubung.");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        "Koneksi ditutup karena ",
        lastDisconnect?.error,
        ", menyambungkan kembali... ",
        shouldReconnect,
      );

      waState.status = "disconnected";
      io.emit("status", "Koneksi terputus. Mencoba menyambungkan kembali...");

      if (shouldReconnect) {
        if (!reconnecting) {
          reconnecting = true;
          try {
            await delay(1000);
            await initializeWhatsApp(io);
          } finally {
            reconnecting = false;
          }
        }
      } else {
        io.emit(
          "status",
          'Koneksi terputus permanen. Silakan hapus folder "sessions" dan mulai ulang.',
        );
      }
      return;
    }

    if (connection === "open") {
      console.log("WhatsApp terhubung");
      waState.status = "connected";
      waState.qr = null;
      io.emit("status", "WhatsApp berhasil terhubung!");
      io.emit("qr", null);

      // v7: preload groups agar sendMessage bisa resolve by subject secara konsisten
      try {
        const participating = await sock.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(participating || {})) {
          groups[jid] = meta;
        }
      } catch (e) {
        // tidak fatal
      }
      return;
    }

    // v7: pairing code flow (kalau QR tidak muncul/ingin tanpa scan)
    // Set env WA_PAIR_NUMBER=62812xxxxxx
    if (
      connection === "connecting" &&
      !qr &&
      process.env.WA_PAIR_NUMBER &&
      waState.status !== "connected"
    ) {
      try {
        const msisdn = process.env.WA_PAIR_NUMBER.replace(/[^0-9]/g, "");
        const code = await sock.requestPairingCode(msisdn);
        io.emit("qr", null);
        io.emit(
          "status",
          `Pairing code: ${code} (WhatsApp > Linked devices > Link a device)`,
        );
        console.log("Pairing code:", code);
      } catch (e) {
        // tidak fatal: QR bisa muncul belakangan
      }
    }
  });

  // Listener untuk menyimpan kredensial/sesi
  sock.ev.on("creds.update", saveCreds);

  // Listener untuk pesan baru
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message) return;

    const fromMe = msg.key.fromMe;
    const jid = msg.key.remoteJid;
    const isGroup = jid?.endsWith("@g.us");
    const direction = fromMe ? "out" : "in";
    const messageText =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    let displayName;

    if (isGroup) {
      let groupMeta = groups[jid];
      if (!groupMeta) {
        try {
          groupMeta = await sock.groupMetadata(jid);
          groups[jid] = groupMeta;
        } catch (e) {
          console.error("Gagal mengambil metadata grup:", e);
        }
      }

      const groupName = groupMeta?.subject || jid.split("@")[0];
      const groupId = jid.split("@")[0];

      if (fromMe) {
        displayName = `Anda -> Group ${groupName} (${groupId})`;
      } else {
        const participantJid = msg.key.participant;
        let finalSenderDisplay;

        if (participantJid) {
          const participantName =
            contacts[participantJid]?.name ||
            contacts[participantJid]?.notify ||
            msg.pushName ||
            participantJid.split("@")[0];
          finalSenderDisplay = `${groupName}(${groupId}) > ${participantName}`;
        } else {
          finalSenderDisplay = `${groupName} (${groupId}) > [Pesan Sistem]`;
        }

        displayName = finalSenderDisplay;
      }
    } else {
      const cleanNumber = jid.split("@")[0];
      let contactName;

      if (fromMe) {
        contactName = contacts[jid]?.name || contacts[jid]?.notify || cleanNumber;
        displayName = `Anda -> ${contactName} (${cleanNumber})`;
      } else {
        contactName =
          contacts[jid]?.name ||
          contacts[jid]?.notify ||
          msg.pushName ||
          cleanNumber;
        displayName = `${contactName} (${cleanNumber})`;
      }
    }

    console.log(
      `Pesan [${direction.toUpperCase()}] dari/ke ${displayName}: ${messageText}`,
    );

    io.emit("message", {
      from: displayName,
      text: messageText,
      timestamp: new Date().toLocaleTimeString(),
      direction,
    });

    if (!fromMe && messageText.toLowerCase() === "halo") {
      await sock.sendMessage(jid, { text: "Halo juga! Saya adalah bot." });
    }
  });

  return sock;
}

const getWAState = () => {
  return waState;
};

async function sendMessage(to, text) {
  if (waState.status !== "connected") {
    return { success: false, message: "WhatsApp belum terhubung." };
  }

  try {
    let jid = to;
    let recipientName = to;

    if (to.endsWith("@g.us") || to.endsWith("@s.whatsapp.net")) {
      jid = to;
    } else {
      // Prioritas 2: Cari di nama grup
      const group = Object.values(groups).find(
        (g) => g?.subject?.toLowerCase?.() === to.toLowerCase(),
      );

      if (group) {
        jid = group.id;
        recipientName = group.subject;
      } else {
        // Prioritas 3: Cari di nama kontak
        const contact = Object.values(contacts).find(
          (c) => c?.name?.toLowerCase?.() === to.toLowerCase(),
        );

        if (contact) {
          jid = contact.id;
          recipientName = contact.name;
        } else {
          // Prioritas 4: Anggap sebagai nomor telepon dan normalisasi
          let cleanedNumber = to.replace(/[^0-9]/g, "");
          if (cleanedNumber.startsWith("0")) {
            cleanedNumber = "62" + cleanedNumber.substring(1);
          }
          if (!cleanedNumber.startsWith("62")) {
            cleanedNumber = "62" + cleanedNumber;
          }
          jid = `${cleanedNumber}@s.whatsapp.net`;

          const finalContact = contacts[jid];
          if (finalContact) {
            recipientName = finalContact.name || finalContact.notify;
          }
        }
      }
    }

    if (!jid) {
      return {
        success: false,
        message: `Tidak dapat menemukan penerima untuk "${to}"`,
      };
    }

    // v7: normalize jid (safety)
    jid = jidNormalizedUser(jid);

    // Validasi nomor di WhatsApp
    if (!jid.endsWith("@g.us")) {
      const [result] = await sock.onWhatsApp(jid);
      if (!result || !result.exists) {
        return {
          success: false,
          message: `Nomor "${to}" tidak terdaftar di WhatsApp.`,
        };
      }
    }

    await sock.presenceSubscribe(jid);
    await delay(500);

    await sock.sendPresenceUpdate("composing", jid);
    const randomTypingTime = getRandomDelay(1500, 3500);
    await delay(randomTypingTime);
    await sock.sendPresenceUpdate("paused", jid);

    await sock.sendMessage(jid, { text });
    console.log(`Pesan terkirim ke ${jid} (${recipientName})`);

    return { success: true, message: `Pesan berhasil dikirim ke ${to}` };
  } catch (error) {
    console.error("Gagal mengirim pesan:", error);
    return {
      success: false,
      message: `Gagal mengirim pesan: ${error.message}`,
    };
  }
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { initializeWhatsApp, getWAState, sendMessage };
