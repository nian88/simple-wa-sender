// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database.js');
const { initializeWhatsApp, getWAState, sendMessage } = require('./whatsapp-client');
const { MessageQueue } = require("./message-queue");
const crypto = require("crypto");

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 62542;
const KEY_SECRET = process.env.KEY_SECRET || 'kunci_rahasia_session_anda';
const MODE = process.env.MODE || "local";

app.use(express.json());
// Middleware untuk parsing form data (untuk login/register)
app.use(express.urlencoded({ extended: true }));

// Menyajikan file statis dari folder 'public'
// app.use(express.static(path.join(__dirname, 'public')));

// Middleware untuk session management
app.use(session({
    secret: KEY_SECRET, // Ganti dengan secret yang lebih kompleks
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: 'auto', // <-- Kunci utama: 'auto' akan otomatis true jika koneksi via HTTPS
        httpOnly: true, // Mencegah akses cookie dari JavaScript sisi klien
        maxAge: 24 * 60 * 60 * 1000 // 1 hari
    } // Sesi berlaku 1 hari
}));

app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

// Middleware untuk memeriksa apakah user sudah login
const isLoggedIn = (req, res, next) => {
    console.log(`[isLoggedIn] Mengecek sesi untuk path: ${req.path}`);
    console.log(`[isLoggedIn] Session ID: ${req.session.id}, User ID: ${req.session.userId}`);
    if (req.session.userId) {
        console.log(`[isLoggedIn] Akses diizinkan.`);
        next();
    } else {
        console.log(`[isLoggedIn] Akses ditolak, redirecting ke /login.`);
        res.redirect('/login');
    }
};

// Rute utama untuk menyajikan halaman HTML
app.get('/dashboard', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard'); // Jika sudah login, langsung ke dashboard
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rute untuk menampilkan halaman register
app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    if(MODE=="production") return res.status(400).send('hubungi Admin.');
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Bulk tester page (optional: protect with isLoggedIn)
app.get("/bulk-test", isLoggedIn, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bulk-test.html"));
});

// Rute untuk menghandle proses register
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).send('Username dan password diperlukan.');

        const hashedPassword = await bcrypt.hash(password, 10); // Hash password
        const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;

        db.run(sql, [username, hashedPassword], function(err) {
            if (err) {
                // Error jika username sudah ada
                console.log(`gagal User baru : ${err}`);
                return res.status(400).send('Gagal mendaftar. Username mungkin sudah digunakan.');
            }
            console.log(`User baru telah dibuat dengan ID: ${this.lastID}`);
            res.redirect('/login');
        });
    } catch (error) {
        res.status(500).send('Terjadi error di server.');
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const sql = `SELECT * FROM users WHERE username = ?`;

    db.get(sql, [username], async (err, user) => {
        if (err || !user) {
            console.log(`[POST /login] Login gagal: User ${username} tidak ditemukan.`);
            return res.redirect('/login'); // Sebaiknya beri pesan error di halaman
        }

        // Bandingkan password yang diinput dengan hash di DB
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            // Jika cocok, simpan ID user di session
            console.log(`[POST /login] Login sukses untuk user: ${user.username} (ID: ${user.id})`);
            req.session.userId = user.id;
            console.log(`[POST /login] Sesi (ID: ${req.session.userId})`);
            req.session.save(err => {
                if (err) {
                    console.error('[POST /login] Gagal menyimpan sesi:', err);
                    return res.redirect('/login');
                }
                console.log(`[POST /login] Sesi berhasil disimpan, redirecting ke /`);
                res.redirect('/dashboard');
            });
        } else {
            console.log(`[POST /login] Login gagal: Password salah untuk user ${username}.`);
            res.redirect('/login'); // Password salah
        }
    });
});

// Rute untuk logout
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid'); // Hapus cookie sesi
        res.redirect('/login');
    });
});

const API_KEY = KEY_SECRET;

// Middleware untuk validasi API Key
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === API_KEY) {
        next(); // Kunci valid, lanjutkan ke proses selanjutnya
    } else {
        res.status(401).json({
            success: false,
            message: 'Unauthorized: API Key tidak valid atau tidak ada.'
        });
    }
};

// Konservatif untuk jam padat presensi
const messageQueue = new MessageQueue({
    minDelayMs: 3000,
    maxDelayMs: 6500,
    burstLimit: 10,
    burstCooldownMs: 45000,
    dedupTtlMs: 3 * 60 * 1000,
});

// Helper untuk membuat dedupKey presensi
// Tetap kompatibel dengan body lama {to, text} tanpa meta.
// - Jika meta tersedia: pakai studentId+type+date (lebih akurat)
// - Jika tidak: pakai to + hash(text) + time-bucket (mengurangi duplikasi burst)
function makeDedupKey(body) {
    const meta = body?.meta;

    // Prefer meta-based dedup (akurat untuk presensi)
    if (meta?.studentId && meta?.type && meta?.date) {
        return `presence:${meta.studentId}:${meta.type}:${meta.date}`;
    }

    // Backward compatible: dedup berbasis payload yang ada
    const to = body?.to;
    const text = body?.text;
    if (!to || !text) return null;

    // time bucket (mis. 2 menit) agar pesan identik tidak terkirim berkali-kali dalam window pendek,
    // tapi tetap bisa terkirim lagi pada window berikutnya (mis. datang vs pulang berbeda teksnya)
    const bucketMs = 2 * 60 * 1000;
    const bucket = Math.floor(Date.now() / bucketMs);

    const hash = crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
    return `payload:${to}:${hash}:${bucket}`;
}

app.post('/api/send-message', async (req, res) => {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== API_KEY) {
        return res.status(401).json({ success: false, message: "API Key tidak valid" });
    }

    const { to, text } = req.body || {};
    if (!to || !text) {
        return res.status(400).json({ success: false, message: "to/text wajib diisi" });
    }

    const dedupKey = makeDedupKey(req.body);

    const enq = messageQueue.enqueue(
        async () => {
            await sendMessage(to, text);
        },
        { dedupKey },
    );

    if (!enq.accepted && enq.reason === "duplicate") {
        return res.json({ success: true, message: "Duplikat terdeteksi, skip kirim." });
    }

    return res.json({
        success: true,
        message: `Queued. Antrian saat ini: ${messageQueue.size()}`,
    });
});

// Setup koneksi Socket.IO
io.on('connection', (socket) => {
    console.log('Client terhubung via Socket.IO');
    const currentState = getWAState();
    if (currentState.status === 'connected') {
        socket.emit('status', 'WhatsApp berhasil terhubung!');
        socket.emit('qr', null); // Pastikan QR code disembunyikan
    } else if (currentState.status === 'qr_received') {
        socket.emit('status', 'Silakan pindai QR code untuk terhubung.');
        socket.emit('qr', currentState.qr);
    } else {
        socket.emit('status', 'Menghubungkan ke WhatsApp...');
    }

    socket.on("send-message", async (data) => {
        try {
            const { to, text } = data || {};
            if (!to || !text) {
                socket.emit("send-status", { success: false, message: "to/text wajib diisi" });
                return;
            }

            const dedupKey = makeDedupKey(data);

            const enq = messageQueue.enqueue(
                async () => {
                    const result = await sendMessage(to, text);
                    socket.emit("send-status", result);
                },
                { dedupKey },
            );

            if (!enq.accepted && enq.reason === "duplicate") {
                socket.emit("send-status", {
                    success: true,
                    message: "Duplikat terdeteksi, pesan tidak dikirim ulang.",
                });
                return;
            }

            socket.emit("send-status", {
                success: true,
                message: `Dimasukkan ke antrian. Posisi saat ini: ${messageQueue.size()}`,
            });
        } catch (e) {
            socket.emit("send-status", { success: false, message: e.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client terputus');
    });
});

// Inisialisasi WhatsApp dan teruskan instance 'io'
initializeWhatsApp(io).catch(err => console.error("Gagal menginisialisasi WhatsApp:", err));

server.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
