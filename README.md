# YouTube Multi-Resolution Downloader (Heroku Ready)

Fullstack YouTube Video & Audio Downloader dengan on-the-fly FFmpeg muxing engine.

## Struktur Berkas
```
├── Procfile             # Konfigurasi start dyno web Heroku (web: node server.js)
├── package.json         # Dependency Node.js & versi engine
├── server.js            # Express backend + FFmpeg remuxing + stream handlers
├── .gitignore           # File yang diabaikan dari repo (node_modules, dll.)
└── public/
    ├── index.html       # Antarmuka web modern dark-mode
    ├── style.css        # Desain glassmorphism responsif
    └── app.js           # Client fetching & download trigger
```

## Cara Deploy ke Heroku

### Opsi 1: Lewat Heroku CLI (Terminal / Command Prompt)

1. Pastikan Anda sudah login ke Heroku CLI:
   ```bash
   heroku login
   ```

2. Di dalam folder ini, inisialisasi Git:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for Heroku"
   ```

3. Buat aplikasi di Heroku:
   ```bash
   heroku create nama-aplikasi-kamu
   ```

4. Push ke Heroku:
   ```bash
   git push heroku master
   ```
   *(atau `git push heroku main` tergantung branch default Anda)*

5. Buka aplikasi:
   ```bash
   heroku open
   ```

---

### Opsi 2: Lewat GitHub (Heroku Dashboard)

1. Ekstrak file zip ini dan upload ke repository GitHub Anda (bisa public atau private).
2. Buka [Heroku Dashboard](https://dashboard.heroku.com/).
3. Klik **New** -> **Create new app**.
4. Di tab **Deploy**, pilih deployment method **GitHub**.
5. Cari repository Anda dan klik **Connect**.
6. Klik **Deploy Branch** (Manual deploy) atau aktifkan **Enable Automatic Deploys**.
7. Selesai! Web downloader Anda aktif 24/7.
