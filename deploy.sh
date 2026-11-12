#!/usr/bin/env bash
# One-step install/update on an Ubuntu or Debian server.  Run from this folder:  sudo ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  read -rp "Domain for the app (e.g. app.mamasandlove.lk): " DOMAIN
  read -rp "Admin username [admin]: " ADMIN_USER; ADMIN_USER=${ADMIN_USER:-admin}
  ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')
  cat > .env <<ENV
DOMAIN=$DOMAIN
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASSWORD
SESSION_SECRET=$(openssl rand -hex 32)
SESSION_DAYS=7
ENV
  chmod 600 .env
  echo; echo "Admin sign-in:  $ADMIN_USER / $ADMIN_PASSWORD   (change it after first sign-in)"; echo
fi

mkdir -p data/backups
chown -R 1000:1000 data

docker compose up -d --build

# Daily database snapshot at 02:30, newest 30 kept in ./data/backups
CRON="30 2 * * * cd $(pwd) && docker compose exec -T app node --experimental-sqlite --disable-warning=ExperimentalWarning scripts/backup.js >> $(pwd)/data/backups/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'scripts/backup.js' ; echo "$CRON" ) | crontab -

. ./.env
echo "Done. Open https://$DOMAIN  (HTTPS certificate is issued automatically on the first visit)."
