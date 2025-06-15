# ================== TAHAP 1: BUILDER ==================
# Gunakan image Node.js versi LTS (Long-Term Support) yang ringan (Alpine Linux)
FROM node:22-alpine AS builder

# Tentukan direktori kerja di dalam container
WORKDIR /app

# Salin package.json dan package-lock.json untuk memanfaatkan cache Docker
COPY package*.json ./

# Instal semua dependensi, termasuk devDependencies yang mungkin dibutuhkan untuk build
RUN npm install

# Salin sisa kode aplikasi
COPY . .

# ================== TAHAP 2: RUNTIME ==================
# Mulai dari image Node.js yang sama, bersih dan ringan
FROM node:22-alpine

WORKDIR /app

# Salin package.json untuk referensi
COPY package*.json ./

# Instal HANYA dependensi produksi untuk menjaga image tetap kecil
RUN npm install --omit=dev

# Salin kode aplikasi dari tahap builder
COPY --from=builder /app .

# Buat user non-root untuk keamanan
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Ekspos port yang digunakan oleh aplikasi
EXPOSE 3000

# Perintah default untuk menjalankan aplikasi saat container dimulai
CMD ["node", "server.js"]