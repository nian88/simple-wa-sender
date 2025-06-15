// database.js
const sqlite3 = require('sqlite3').verbose();

// Buat atau hubungkan ke file database app.db
const db = new sqlite3.Database('./app.db', (err) => {
    if (err) {
        console.error('Error saat membuka database', err.message);
    } else {
        console.log('Terhubung ke database SQLite.');
        // Buat tabel users jika belum ada
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )`, (err) => {
            if (err) {
                console.error('Error saat membuat tabel users', err.message);
            } else {
                console.log('Tabel "users" sudah siap.');
            }
        });
    }
});

module.exports = db;