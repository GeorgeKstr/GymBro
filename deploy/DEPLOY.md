# Deploying GymBro to DigitalOcean

One droplet, one domain, ~30 minutes.

## 1. Create the droplet
- **Images:** Ubuntu 24.04 LTS
- **Size:** Basic → Regular → **$6/mo (1 vCPU / 1GB RAM / 25GB SSD)** is plenty.
  ($4 "Samo" 512MB also works but is tight when the AI parse is invoked.)
- **Options:** check ✅ *IPv6*, add your SSH key.
- Fire up, note the **public IP**.

## 2. DNS
In your domain registrar (or DO → Networking → Domains):
```
A    gym    <droplet-IP>     (or `gym.example.com`)
```
Wait until `dig +short gym.example.com` returns the IP.

## 3. Server setup (paste as one block over SSH)
```bash
ssh root@<droplet-IP>

apt update && apt -y upgrade
apt install -y python3-venv git caddy

# run the app as an unprivileged user, code lives in /opt/gymbro
useradd -r -m -d /opt/gymbro -s /usr/sbin/nologin gymbro
```

## 4. Get the code
```bash
git clone https://github.com/GeorgeKstr/GymBro.git /opt/gymbro   # or scp -r
cd /opt/gymbro
python3 -m venv .venv
.venv/bin/pip install -U pip && .venv/bin/pip install -r requirements.txt
chown -R gymbro:gymbro /opt/gymbro
```

## 5. Secrets
```bash
sudo -u gymbro cp .env.example .env
sudo -u gymbro nano .env
```
Fill in: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAIL`, AI keys
(same values you use locally — copy the existing `.env` file with
`scp .env root@<ip>:/opt/gymbro/.env && chown gymbro /opt/gymbro/.env`).

## 6. Run it (systemd)
```bash
cp deploy/gymbro.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gymbro
journalctl -u gymbro -f          # should print "Starting GymBro on 127.0.0.1:8020"
```

## 7. HTTPS with Caddy
```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile      # edit the domain inside first!
systemctl enable --now caddy
```
Caddy fetches Let's Encrypt certs automatically. Check `https://gym.example.com`.

## 8. Google OAuth
In Google Cloud Console → APIs & Services → Credentials → your OAuth client:
- **Authorized redirect URIs:** add `https://gym.example.com/api/auth/google/callback`
  (check the exact callback path in `app.py` / `config.py`).
- **Authorized JavaScript origins:** add `https://gym.example.com`.
- Consent screen: **publish** the app (In production) so non-test users can log in.

## 9. SQLite backups (cron, nightly)
```bash
echo '0 3 * * * gymbro  sqlite3 /opt/gymbro/gymbro.db ".backup /opt/gymbro/.backups/db-$(date +\%F).db"' \
  > /etc/cron.d/gymbro-backup
mkdir -p /opt/gymbro/.backups && chown gymbro /opt/gymbro/.backups
# keep last 14 days only:
echo '14 3 * * * root  find /opt/gymbro/.backups -name "db-*.db" -mtime +14 -delete' >> /etc/cron.d/gymbro-backup
```

## Updating later
```bash
ssh root@<ip>
cd /opt/gymbro && sudo -u gymbro git pull
systemctl restart gymbro
```

## Firewall (optional but wise)
```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```
(DO Cloud Firewalls in the control panel work too.)
