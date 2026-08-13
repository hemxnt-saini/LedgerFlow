#!/usr/bin/env bash
# One command to take a bare Ubuntu box to a running HTTPS deployment.
#
#   sudo ./bootstrap.sh ledgerflow.duckdns.org you@example.com
#
# Installs Docker, opens both firewall layers, clones the repo, writes .env
# with a generated database password, deploys, and installs the nightly demo
# reset. Safe to re-run - every step checks before acting, and an existing
# .env is never overwritten.
set -euo pipefail

REPO=https://github.com/hemxnt-saini/LedgerFlow.git
BRANCH=develop
TARGET=/opt/ledgerflow

DOMAIN=${1:-${DOMAIN:-}}
EMAIL=${2:-${EMAIL:-}}
SKIP_DNS_CHECK=${SKIP_DNS_CHECK:-false}

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo $0 $*"
[ -n "$DOMAIN" ] || die "usage: sudo $0 <domain> <email>"
[ -n "$EMAIL" ] || die "usage: sudo $0 <domain> <email>"

# The account the box was set up with, so the checkout is not root-owned and
# 'git pull' later does not need sudo. Falls back to root for a root login.
OWNER=${SUDO_USER:-root}

# ---------------------------------------------------------------- preflight
# Let's Encrypt rate-limits failed authorisations, so a domain pointing at the
# wrong place is worth catching before Caddy burns attempts on it.
step "Checking that $DOMAIN points here"
PUBLIC_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null ||
            curl -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true)
RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)

echo "    this machine: ${PUBLIC_IP:-unknown}"
echo "    $DOMAIN -> ${RESOLVED:-does not resolve}"

if [ "$SKIP_DNS_CHECK" != "true" ]; then
  [ -n "$RESOLVED" ] || die "$DOMAIN does not resolve yet. Add the A record, wait a minute, and re-run.
       Override with: SKIP_DNS_CHECK=true sudo $0 $DOMAIN $EMAIL"
  if [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
    die "$DOMAIN points at $RESOLVED, not this machine ($PUBLIC_IP).
       Fix the A record, or override with SKIP_DNS_CHECK=true if you are behind a proxy."
  fi
  echo "    ok"
fi

# ------------------------------------------------------------------- docker
step "Docker"
if command -v docker >/dev/null 2>&1; then
  echo "    already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  echo "    installed: $(docker --version)"
fi
# So the human can run docker without sudo after their next login.
if [ "$OWNER" != root ]; then
  usermod -aG docker "$OWNER"
fi

# ----------------------------------------------------------------- firewall
# Two layers on Oracle. This handles the host; the VCN Security List has to be
# opened in the web console and cannot be done from here.
step "Opening ports 80 and 443 on the host"
for port in 80 443; do
  if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    echo "    $port already allowed"
  else
    # Insert at the top: Oracle's Ubuntu images ship a REJECT rule that would
    # otherwise match first, and appending would have no effect.
    iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
    echo "    $port allowed"
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$port"/tcp >/dev/null 2>&1 || true
  fi
done

# Survive a reboot. Without this the rules are lost and the site goes dark
# the first time the box restarts.
if ! command -v netfilter-persistent >/dev/null 2>&1; then
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1
fi
netfilter-persistent save >/dev/null 2>&1 && echo "    saved for reboot"

# ------------------------------------------------------------------- source
step "Source at $TARGET"
if [ -d "$TARGET/.git" ]; then
  git -C "$TARGET" fetch --quiet origin "$BRANCH"
  git -C "$TARGET" checkout --quiet "$BRANCH"
  git -C "$TARGET" reset --hard --quiet "origin/$BRANCH"
  echo "    updated to $(git -C "$TARGET" rev-parse --short HEAD)"
else
  command -v git >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git
  git clone --quiet --branch "$BRANCH" "$REPO" "$TARGET"
  echo "    cloned $(git -C "$TARGET" rev-parse --short HEAD)"
fi
chown -R "$OWNER":"$OWNER" "$TARGET"

# --------------------------------------------------------------------- .env
step "Configuration"
if [ -f "$TARGET/.env" ]; then
  echo "    .env already exists, leaving it alone"
else
  # Hex rather than base64: this password is interpolated into
  # postgres://payments:PASSWORD@postgres:5432/payments, and base64's '/'
  # terminates the authority section, making the URL unparseable. At 32 base64
  # characters that lands about two times in five. Hex has no such characters.
  PASSWORD=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > "$TARGET/.env" <<ENVEOF
DOMAIN=$DOMAIN
EMAIL=$EMAIL
POSTGRES_PASSWORD=$PASSWORD
DEMO_ENDPOINTS=true
ENVEOF
  chown "$OWNER":"$OWNER" "$TARGET/.env"
  chmod 600 "$TARGET/.env"
  echo "    written with a generated database password"
fi

# ------------------------------------------------------------------- deploy
step "Deploying (first run builds the images, 3-5 minutes)"
"$TARGET/deploy/deploy.sh"

# --------------------------------------------------------------------- cron
# The demo controls are deliberately open, so a nightly reset keeps the public
# URL presentable without anyone having to notice it broke.
step "Nightly demo reset"
CRON_LINE="0 4 * * * cd $TARGET && ./deploy/reset-demo.sh >> /var/log/ledgerflow-reset.log 2>&1"
if crontab -l 2>/dev/null | grep -qF 'reset-demo.sh'; then
  echo "    already scheduled"
else
  { crontab -l 2>/dev/null || true; echo "$CRON_LINE"; } | crontab -
  echo "    scheduled for 04:00 daily"
fi

# ------------------------------------------------------------------- verify
step "Verifying"
for _ in $(seq 1 30); do
  CODE=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" 2>/dev/null || echo 000)
  [ "$CODE" = "200" ] && break
  sleep 5
done
echo "    GET https://$DOMAIN/            $CODE"
echo "    GET /api/write/health           $(curl -fsS --max-time 10 "https://$DOMAIN/api/write/health" 2>/dev/null || echo unreachable)"
echo "    GET /api/read/health            $(curl -fsS --max-time 10 "https://$DOMAIN/api/read/health" 2>/dev/null || echo unreachable)"

echo
if [ "$CODE" = "200" ]; then
  echo "Done.  https://$DOMAIN"
else
  echo "The stack is up but https://$DOMAIN did not answer."
  echo "Almost always the VCN Security List: open TCP 80 and 443 for 0.0.0.0/0"
  echo "in the Oracle console, then check:  docker compose -f $TARGET/docker-compose.yml -f $TARGET/docker-compose.prod.yml logs caddy"
fi
