# VPS deployment — Car Soccer online multiplayer

Run these on the VPS itself (SSH in first). Replace `your-domain.example.com` with your actual domain, and `/opt/car-soccer` with wherever you want the checkout to live. Assumes Ubuntu/Debian — adjust the package manager commands if your VPS runs something else.

Note: `git clone` below needs this repo pushed to a git remote you can reach from the VPS (e.g. a private GitHub repo). If you'd rather not push it anywhere, substitute `rsync`/`scp` from your PC instead of the clone step, and use the same tool for the "redeploying" step at the end.

## 1. Clone the repo

```bash
sudo mkdir -p /opt/car-soccer
sudo chown $USER:$USER /opt/car-soccer
git clone <your-repo-url> /opt/car-soccer
cd /opt/car-soccer
```

## 2. Install and start the relay server

```bash
cd /opt/car-soccer/multiplayer-server
npm install --omit=dev
```

Create the systemd unit `/etc/systemd/system/car-soccer-relay.service`:

```ini
[Unit]
Description=Car Soccer online multiplayer relay server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/car-soccer/multiplayer-server
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Restart=on-failure
RestartSec=2
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now car-soccer-relay
sudo systemctl status car-soccer-relay
```
Expected: `active (running)`.

## 3. Install Nginx and certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 4. Nginx site config

Create `/etc/nginx/sites-available/car-soccer`:

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    root /opt/car-soccer/car-soccer-mirror;
    index index.html;

    location /mp {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/car-soccer /etc/nginx/sites-enabled/car-soccer
sudo nginx -t
sudo systemctl reload nginx
```
Expected: `nginx -t` reports `syntax is ok` / `test is successful`.

## 5. Get a TLS certificate

```bash
sudo certbot --nginx -d your-domain.example.com
```
Follow the prompts (email address, agree to terms). Certbot edits the Nginx config in place to add the `listen 443 ssl` block and redirect HTTP → HTTPS, and sets up auto-renewal.

## 6. Verify

Visit `https://your-domain.example.com` in a browser — the game should load with a valid padlock (no certificate warning). Open the browser's network/console tools and confirm a "Play Online" → "Create a room" attempt opens a `wss://your-domain.example.com/mp` connection successfully (no mixed-content or connection errors).

## Redeploying after a code change

```bash
cd /opt/car-soccer
git pull
sudo systemctl restart car-soccer-relay
```
(Static file changes need no restart — Nginx serves them directly. Only relay-server changes need the `systemctl restart`.)
