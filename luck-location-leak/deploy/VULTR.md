# Deploy on Vultr (Best Use of Vultr)

Target: one Vultr Cloud Compute instance (Regular, 1 vCPU / 1 GB, Ubuntu 24.04, ~$5/mo) serving the dashboard and the Pit Boss API over HTTPS.

```bash
# 1. create the instance in the Vultr console, note its IP, then from your computer:
ssh root@<VULTR_IP>

# 2. on the instance
apt-get update && apt-get install -y docker.io caddy unzip
# upload the project (from Windows PowerShell:  scp luck-location-leak.zip root@<VULTR_IP>:/root/ )
unzip luck-location-leak.zip && cd luck-location-leak
cp .env.example .env && nano .env          # paste your keys on the server only
docker build -f deploy/Dockerfile -t pitboss .
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 \
  --env-file .env \
  --name pitboss pitboss

# 3. HTTPS with your GoDaddy domain (A record @ -> <VULTR_IP>)
cat > /etc/caddy/Caddyfile <<'EOF'
luckorleak.com, www.luckorleak.com {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy
```

Replace `luckorleak.com` with the domain you registered. `data.json` is 4.3 MB; Caddy's gzip brings it to roughly 1 MB on the wire.

In MongoDB Atlas, add the Vultr IP under Network Access, or the server cannot reach the database.

Why Vultr here: the dashboard must be a public link judges can open in a private window; one small VM runs the static site, the FastAPI proxy that keeps the Gemini key off the browser, and the HTTPS endpoint, with predictable cost.
