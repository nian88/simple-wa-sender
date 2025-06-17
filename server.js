// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database.js');
const { initializeWhatsApp, getWAState, sendMessage } = require('./whatsapp-client');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 62542;

app.use(express.json());
// Middleware untuk parsing form data (untuk login/register)
app.use(express.urlencoded({ extended: true }));

// Menyajikan file statis dari folder 'public'
// app.use(express.static(path.join(__dirname, 'public')));

// Middleware untuk session management
app.use(session({
    secret: 'kunci_rahasia_session_anda', // Ganti dengan secret yang lebih kompleks
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
    console.log(`orint ${isLoggedIn}`);
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard'); // Jika sudah login, langsung ke dashboard
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rute untuk menampilkan halaman register
app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    return res.status(400).send('hubungi Admin.'); 
    //res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

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

const API_KEY = "RAHASIA123";

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

app.post('/api/send-message', validateApiKey, async (req, res) => {
    // Gunakan middleware 'validateApiKey' untuk melindungi rute ini
    console.log('Request API diterima untuk /api/send-message');

    // 1. Validasi status koneksi WhatsApp
    if (getWAState().status !== 'connected') {
        return res.status(503).json({
            success: false,
            message: 'Service Unavailable: WhatsApp belum terhubung.'
        });
    }

    const { to, text } = req.body;

    // 2. Validasi input dari body request
    if (!to || !text) {
        return res.status(400).json({
            success: false,
            message: 'Bad Request: Mohon sertakan "to" dan "text" dalam body request.'
        });
    }

    try {
        // 3. Panggil fungsi sendMessage yang sudah cerdas
        const result = await sendMessage(to, text);

        // 4. Kirim response berdasarkan hasil dari sendMessage
        if (result.success) {
            res.status(200).json(result);
        } else {
            // Jika sendMessage gagal (misal nomor tidak ada), kirim error
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('Error pada API /send-message:', error);
        res.status(500).json({
            success: false,
            message: 'Internal Server Error'
        });
    }
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

    socket.on('send-message', async (data) => {
        const { number, message } = data;
        const result = await sendMessage(number, message);
        // Kirim status kembali ke klien yang meminta
        socket.emit('send-status', result);
    });
    // =

    socket.on('disconnect', () => {
        console.log('Client terputus');
    });
});

// Inisialisasi WhatsApp dan teruskan instance 'io'
initializeWhatsApp(io).catch(err => console.error("Gagal menginisialisasi WhatsApp:", err));

server.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
