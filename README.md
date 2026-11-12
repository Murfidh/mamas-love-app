# Mamas and Love Manager

Business system for Mamas and Love: associate costs, dated pricing, purchases (local and import), goods received notes, invoicing without stock blocking, cheque tracking and reminders, collections, supplier and customer accounts, and analysis.

It is one Node.js server with a built-in SQLite database. There's nothing else to install or pay for.

```
server.js            web server and API
lib/db.js            database (SQLite file in DATA_DIR)
public/index.html    the app
scripts/             backup, import, reset-password, seed-demo
deploy.sh            one-step install on an Ubuntu/Debian server
docker-compose.yml   app + Caddy (automatic HTTPS)
```

## 1. Try it on your own computer

You need Node.js 22.5 or newer (nodejs.org).

```bash
npm install
npm run seed-demo        # optional: loads example records
ADMIN_PASSWORD=pick-a-password npm start
```

Open http://localhost:3000 and sign in as `admin` with that password.

If you don't set `ADMIN_PASSWORD`, a random one is printed in the terminal the first time the app starts.

## 2. Put it in production (recommended: a small VPS)

Any 1 GB Ubuntu server is enough, for example DigitalOcean, Hetzner, AWS Lightsail or Vultr, at about $5–6 a month.

1. **Create the server** with Ubuntu 24.04. Note its IP address.
2. **Point your domain** to it. At your domain registrar, add an `A` record such as `app.mamasandlove.lk` → the server IP.
3. **Copy this folder to the server.** Either push it to a private GitHub repo and `git clone` it, or run:
   ```bash
   scp -r mamas-love-app root@SERVER_IP:/opt/
   ```
4. **Install and start:**
   ```bash
   ssh root@SERVER_IP
   cd /opt/mamas-love-app
   sudo ./deploy.sh
   ```
   The script installs Docker and asks for your domain. It creates `.env` with a random admin password and prints that password. It then starts the app behind Caddy, which gets the HTTPS certificate automatically, and schedules a daily backup.
5. Open `https://your-domain`, sign in and change the admin password in **Settings → Your account**.
6. In **Settings → Users**, add an account for each person:
   - **Staff** can record transactions.
   - **Viewer** is read only.
   - **Admin** also manages settings, users and backups.

Ports 80 and 443 must be open. Most providers have them open by default. On Ubuntu with ufw, run `ufw allow 80,443/tcp`.

### Updating to a new version
Replace the files (or `git pull`), then run `sudo ./deploy.sh` again. Your data in `./data` is kept.

## 3. Alternative: Railway or Render (no server to manage)

1. Push this folder to a private GitHub repo.
2. Create a new service from the repo. The included `Dockerfile` is detected automatically.
3. **Add a persistent volume/disk mounted at `/data`.** This is required: without it, every redeploy wipes the database.
4. Set these environment variables:
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET` (any long random text)
   - `COOKIE_SECURE=true`
5. Add your custom domain in the service settings.

On Render, the persistent disk needs a paid instance (Starter plan or above).

## Moving data from the claude.ai version

1. In the claude.ai version, go to **Settings → Download full backup (JSON)**.
2. In production, go to **Settings → Restore from backup…**, choose that file and confirm.

You can also do it from the server:
```bash
docker compose exec -T app node --experimental-sqlite scripts/import.js /data/backup.json   # after copying the file into ./data
```

The example records are tagged "example". Remove them from **Settings** before you start using real data, or just don't run `seed-demo` in production.

## Backups

- **Automatic:** `deploy.sh` schedules a snapshot every night at 02:30 into `./data/backups`. The newest 30 are kept.
- **Manual snapshot:** `docker compose exec app node --experimental-sqlite scripts/backup.js`
- **Readable export:** **Settings → Download full backup (JSON)**. Keep a weekly copy off the server, for example in Google Drive.
- **Restore a snapshot:**
  ```bash
  docker compose down
  cp data/backups/<file>.db data/mamas-love.db
  rm -f data/mamas-love.db-wal data/mamas-love.db-shm
  docker compose up -d
  ```

## Forgot the admin password

```bash
docker compose exec app node --experimental-sqlite scripts/reset-password.js admin NewPassword123
```

## Settings reference (`.env`)

| Variable | Purpose |
|---|---|
| `DOMAIN` | Domain Caddy serves and issues HTTPS for |
| `ADMIN_USER`, `ADMIN_PASSWORD` | First admin account; only used on the very first start |
| `SESSION_SECRET` | Signs sign-in cookies; generated automatically if empty |
| `SESSION_DAYS` | How long a sign-in lasts (default 7) |
| `PORT` | App port (default 3000) |
| `DATA_DIR` | Where the database lives (default `./data`, `/data` in Docker) |
| `COOKIE_SECURE` | `true` when served over HTTPS |

## What the server adds over the claude.ai version

- Sign-in with Admin, Staff and Viewer roles
- An activity log of who changed what, shown in Settings
- Duplicate invoice, receipt, GRN, purchase and voucher numbers are refused, so two people billing at once can't clash
- Each user's screen refreshes within about 15 seconds of another user's change
- Invoices print or save as PDF straight from the browser (**Print / PDF** on any invoice)
