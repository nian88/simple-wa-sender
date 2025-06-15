// whatsapp-client.js
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');


let sock;

const contacts = {};
const groups = {};

let waState = {
    status: 'initializing',
    qr: null,
    connection: null,
};


async function initializeWhatsApp(io) {
    const { state, saveCreds } = await useMultiFileAuthState('sessions');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Kita akan handle QR di frontend
        auth: state,
        browser: ['My-Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('contacts.set', (update) => {
        // Hapus kontak lama dan isi dengan yang baru
        Object.assign(contacts, {});
        for (const contact of update.contacts) {
            if (contact.id) {
                contacts[contact.id] = contact;
            }
        }
        console.log('Kontak berhasil dimuat/di-set ulang.');
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            if (contacts[update.id]) {
                Object.assign(contacts[update.id], update);
            } else {
                contacts[update.id] = update;
            }
        }
        console.log('Kontak diperbarui.');
    });


    // Listener untuk event koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        waState.connection = connection;

        if (qr) {
            console.log('QR Code generated');
            waState.status = 'qr_received';
            waState.qr = qr;
            io.emit('qr', qr); // Kirim QR ke frontend via Socket.IO
            io.emit('status', 'Silakan pindai QR code untuk terhubung.');
        }

        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi ditutup karena ', lastDisconnect?.error, ', menyambungkan kembali... ', shouldReconnect);
            waState.status = 'disconnected';
            io.emit('status', 'Koneksi terputus. Mencoba menyambungkan kembali...');
            if (shouldReconnect) {
                initializeWhatsApp(io); // Coba sambungkan lagi
            } else {
                 io.emit('status', 'Koneksi terputus permanen. Silakan hapus folder "sessions" dan mulai ulang.');
            }
        } else if (connection === 'open') {
            console.log('WhatsApp terhubung');
            waState.status = 'connected';
            waState.qr = null; // Tidak ada QR lagi
            io.emit('status', 'WhatsApp berhasil terhubung!');
            io.emit('qr', null); // Hapus QR code dari UI
        }
    });

    // Listener untuk menyimpan kredensial/sesi
    sock.ev.on('creds.update', saveCreds);

    // Listener untuk pesan baru
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const fromMe = msg.key.fromMe;
        const jid = fromMe ? msg.key.remoteJid : msg.key.remoteJid; // JID lawan bicara
        const isGroup = jid.endsWith('@g.us');
        const direction = fromMe ? 'out' : 'in';
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        const cleanNumber = jid.split('@')[0];
        let displayName;

        if (isGroup) {
            // Logika untuk pesan grup
            let groupMeta = groups[jid];
            if (!groupMeta) {
                try {
                    groupMeta = await sock.groupMetadata(jid);
                    groups[jid] = groupMeta; // Simpan ke cache
                } catch (e) {
                    console.error('Gagal mengambil metadata grup:', e);
                }
            }

            const groupName = groupMeta?.subject || jid.split('@')[0];
            const groupId = jid.split('@')[0];

            if (fromMe) {
                // Pesan keluar ke grup
                displayName = `Anda -> Group ${groupName} (${groupId})`;
            } else {
                // Pesan masuk dari partisipan grup
                const participantJid = msg.key.participant;
                const participantName = contacts[participantJid]?.name || contacts[participantJid]?.notify || msg.pushName || participantJid.split('@')[0];
                displayName = `Group ${groupName} (${groupId}) > ${participantName}`;
            }
        } else {
            // Logika untuk pesan pribadi (sama seperti sebelumnya)
            const cleanNumber = jid.split('@')[0];
            let contactName;

            if (fromMe) {
                contactName = contacts[jid]?.name || contacts[jid]?.notify || cleanNumber;
                displayName = `Anda -> ${contactName} (${cleanNumber})`;
            } else {
                contactName = contacts[jid]?.name || contacts[jid]?.notify || msg.pushName || cleanNumber;
                displayName = `${contactName} (${cleanNumber})`;
            }
        }

        console.log(`Pesan [${direction.toUpperCase()}] dari/ke ${displayName}: ${messageText}`);

        // Kirim objek pesan yang sudah diperkaya ke frontend
        io.emit('message', {
            from: displayName,
            text: messageText,
            timestamp: new Date().toLocaleTimeString(),
            direction: direction // Properti baru untuk arah pesan
        });

        // Contoh auto-reply sederhana
        if (!fromMe && messageText.toLowerCase() === 'halo') {
            await sock.sendMessage(jid, { text: 'Halo juga! Saya adalah bot.' });
        }
    });

    return sock;
}


const getWAState = () => {
    return waState;
};

async function sendMessage(to, text) {
    if (waState.status !== 'connected') {
        return { success: false, message: 'WhatsApp belum terhubung.' };
    }

    try {
        // Normalisasi nomor: tambahkan @s.whatsapp.net jika belum ada
        let jid = to;
        let recipientName = to;
        if (to.endsWith('@g.us') || to.endsWith('@s.whatsapp.net')) {
            jid = to;
        } else {
        // Prioritas 2: Cari di nama grup
            const group = Object.values(groups).find(g => g.subject.toLowerCase() === to.toLowerCase());
            if (group) {
                jid = group.id;
                recipientName = group.subject;
            } else {
                // Prioritas 3: Cari di nama kontak
                const contact = Object.values(contacts).find(c => c.name?.toLowerCase() === to.toLowerCase());
                if (contact) {
                    jid = contact.id;
                    recipientName = contact.name;
                } else {
                    // Prioritas 4: Anggap sebagai nomor telepon dan normalisasi
                    let cleanedNumber = to.replace(/[^0-9]/g, '');
                    if (cleanedNumber.startsWith('0')) {
                        cleanedNumber = '62' + cleanedNumber.substring(1);
                    }
                    if (!cleanedNumber.startsWith('62')) {
                        cleanedNumber = '62' + cleanedNumber;
                    }
                    jid = `${cleanedNumber}@s.whatsapp.net`;

                    // Coba cari nama kontak lagi setelah normalisasi
                    const finalContact = contacts[jid];
                    if (finalContact) {
                        recipientName = finalContact.name || finalContact.notify;
                    }
                }
            }
        }

        if (!jid) {
            return { success: false, message: `Tidak dapat menemukan penerima untuk "${to}"` };
        }

        // Validasi nomor/grup di WhatsApp
        if (!jid.endsWith('@g.us')) {
            const [result] = await sock.onWhatsApp(jid);
            if (!result || !result.exists) {
                // Pesan error lebih spesifik untuk nomor
                return { success: false, message: `Nomor "${to}" tidak terdaftar di WhatsApp.` };
            }
        }

        await sock.sendMessage(jid, { text });
        console.log(`Pesan terkirim ke ${jid}`);

        return { success: true, message: `Pesan berhasil dikirim ke ${to}` };
    } catch (error) {
        console.error('Gagal mengirim pesan:', error);
        return { success: false, message: `Gagal mengirim pesan: ${error.message}` };
    }
}

module.exports = { initializeWhatsApp, getWAState, sendMessage };
