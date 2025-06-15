// public/client.js
const socket = io();

// Ambil elemen dari DOM
const statusEl = document.getElementById('status');
const qrcodeEl = document.getElementById('qrcode');
const qrContainer = document.getElementById('qr-container');
const messagesEl = document.getElementById('messages');

// ===== Elemen Form Baru =====
const sendForm = document.getElementById('send-form');
const numberInput = document.getElementById('number');
const messageInput = document.getElementById('message-text');
const sendFeedback = document.getElementById('send-feedback');
// ==========================

socket.on('connect', () => {
    console.log('Terhubung ke server Socket.IO');
});

// Listener untuk event 'status'
socket.on('status', (message) => {
    statusEl.textContent = message;
});

// Listener untuk event 'qr'
socket.on('qr', (qr) => {
    if (qr) {
        QRCode.toCanvas(qrcodeEl, qr, (error) => {
            if (error) console.error(error);
            qrContainer.style.display = 'flex';
        });
    } else {
        qrContainer.style.display = 'none';
    }
});

// Listener untuk event 'message'
socket.on('message', (msg) => {
    const messageElement = document.createElement('div');
    messageElement.className = `message ${msg.direction}`;
    messageElement.innerHTML = `
        <span class="time">${msg.timestamp}</span>
        <span class="from">${msg.from}</span>
        <div class="text">${msg.text}</div>
    `;
    messagesEl.appendChild(messageElement);
    messagesEl.scrollTop = messagesEl.scrollHeight;
});

// ===== LOGIKA FORM BARU =====
sendForm.addEventListener('submit', (e) => {
    e.preventDefault(); // Mencegah form reload halaman

    const number = numberInput.value;
    const message = messageInput.value;

    if (!number || !message) {
        sendFeedback.textContent = 'Nomor dan pesan tidak boleh kosong!';
        sendFeedback.style.color = 'red';
        return;
    }

    // Kirim data ke server via socket
    socket.emit('send-message', { number, message });

    sendFeedback.textContent = 'Mengirim...';
    sendFeedback.style.color = '#606770';
});

// Listener untuk status pengiriman dari server
socket.on('send-status', (data) => {
    sendFeedback.textContent = data.message;
    sendFeedback.style.color = data.success ? 'green' : 'red';

    // Jika sukses, kosongkan form
    if (data.success) {
        numberInput.value = '';
        messageInput.value = '';
    }
});
// ==========================