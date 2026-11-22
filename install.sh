#!/usr/bin/env bash
# Pemasang Palic v2: cek Node, pasang dependensi, siapkan .env, jalankan tes, lalu (opsional) jalankan dengan pm2.
set -euo pipefail
cd "$(dirname "$0")"

need_node_major=22; need_node_minor=13
if ! command -v node >/dev/null 2>&1; then echo "Node.js belum terpasang. Pasang Node >= 22.13 (mis. lewat nvm) lalu ulangi."; exit 1; fi
v=$(node -p 'process.versions.node'); major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
if (( major < need_node_major || (major == need_node_major && minor < need_node_minor) )); then
  echo "Node $v terlalu lama. Butuh >= 22.13."; exit 1
fi
echo "Node $v OK"

# canvas butuh pustaka sistem bila tidak ada biner siap pakai untuk OS ini.
if command -v apt-get >/dev/null 2>&1 && ! dpkg -s libcairo2 >/dev/null 2>&1; then
  echo "Catatan: bila 'npm ci' gagal di paket canvas, jalankan:"
  echo "  sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev"
fi

npm ci --no-audit --no-fund

if [ ! -f .env ]; then cp .env.example .env; chmod 600 .env; echo "Dibuat .env dari .env.example (izin 600). Isi TELEGRAM_BOT_TOKEN dulu."; fi

echo "Menjalankan tes..."
npm test >/tmp/palic-test.log 2>&1 && echo "Tes lulus." || { echo "Ada tes gagal, lihat /tmp/palic-test.log"; }

cat <<'TXT'

Selesai. Langkah berikutnya:
  1. Isi .env (minimal TELEGRAM_BOT_TOKEN).
  2. Jalankan sekali:        npm start
     Kirim /start ke bot; bot membalas chat id Anda -> isi TELEGRAM_CHAT_ID di .env, hentikan (Ctrl+C).
  3. Jalankan permanen:      npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
  4. Mini App butuh URL HTTPS: isi MINIAPP_PUBLIC_URL, atau jalankan
        cloudflared tunnel --url http://127.0.0.1:8790 --metrics 127.0.0.1:41000
     dan isi MINIAPP_TUNNEL_METRICS=127.0.0.1:41000 (bot membaca URL tunnel dan memasang tombol menu sendiri).
Mode bawaan PAPER. LIVE hanya menyala setelah Anda mengetik LIVE di Mini App (tab Wallet).
TXT
