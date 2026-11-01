#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="xray-manager"
APP_DIR="/opt/xray-manager"
SERVICE_NAME="xray-manager"
REPO="https://github.com/kyawkolatt4989-ux/xray-manager.git"
PORT="3188"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run this installer as root."

command -v apt-get >/dev/null 2>&1 ||
  fail "This installer currently supports Ubuntu/Debian."

if [[ -d "$APP_DIR" ]]; then
  fail "$APP_DIR already exists. Refusing to overwrite existing files."
fi

for cmd in git curl node npm systemctl; do
  command -v "$cmd" >/dev/null 2>&1 ||
    fail "$cmd is missing. Install it before running this installer."
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 20 )) || fail "Node.js 20 or newer is required."

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  fail "Port ${PORT} is already in use. Choose another port first."
fi

echo
echo "======================================"
echo "       XRAY MANAGER INSTALLER"
echo "======================================"
echo

read -rp "Admin username: " ADMIN_USERNAME
[[ "$ADMIN_USERNAME" =~ ^[a-zA-Z0-9_-]{3,32}$ ]] ||
  fail "Username must be 3-32 characters (letters, numbers, _ or -)."

read -rsp "Admin password (minimum 12 characters): " ADMIN_PASSWORD
echo
[[ ${#ADMIN_PASSWORD} -ge 12 ]] ||
  fail "Password must contain at least 12 characters."

SESSION_SECRET="$(openssl rand -hex 32)"

info "Downloading Xray Manager from GitHub..."

git clone --depth 1 "$REPO" "$APP_DIR" ||
  fail "Could not download repository."

cd "$APP_DIR"

for file in package.json server.js xray.js; do
  [[ -s "$file" ]] || fail "Required file missing or empty: $file"
done

info "Installing Node.js dependencies..."
npm install --omit=dev ||
  fail "Dependency installation failed."

mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"

cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${PORT}
DATA_DIR=${APP_DIR}/data
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
EOF

chmod 600 "$APP_DIR/.env"

id -u xraymanager >/dev/null 2>&1 ||
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin xraymanager

chown -R xraymanager:xraymanager "$APP_DIR"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Xray Manager Panel
After=network.target

[Service]
Type=simple
User=xraymanager
Group=xraymanager
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

info "Starting Xray Manager..."
systemctl start "$SERVICE_NAME"

sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo
  info "Xray Manager backend installed successfully."
  echo "Service: $SERVICE_NAME"
  echo "Local API: http://127.0.0.1:${PORT}/api/health"
  echo
  warn "Dashboard files and Xray Core integration are not installed yet."
  warn "Do not expose this backend publicly until HTTPS and the frontend are configured."
else
  systemctl status "$SERVICE_NAME" --no-pager || true
  fail "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -n 100"
fi
