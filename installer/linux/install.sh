#!/usr/bin/env bash
# WorldFoundry - install and update (Linux with systemd)
#
#   sudo ./install.sh [--port 3000] [--open-firewall] [--no-start] [--upgrade]
#
# Installs to /opt/worldfoundry, data to /var/lib/worldfoundry, configuration to
# /etc/worldfoundry/worldfoundry.env. Running it again with a newer version is an update:
# data and configuration stay untouched.
#
# The self-update of already installed versions runs this script of the NEW package with --upgrade and only
# checks the exit code and then the health of the application. Flags, paths and unit names must therefore not change.
set -euo pipefail

INSTALL_DIR=/opt/worldfoundry
DATA_DIR=/var/lib/worldfoundry
CONF_DIR=/etc/worldfoundry
CONF_FILE="$CONF_DIR/worldfoundry.env"
FIREWALL_STATE="$CONF_DIR/firewall.state"
UPDATE_ROOT=/var/lib/worldfoundry-update
UNIT_FILE=/etc/systemd/system/worldfoundry.service
UPDATE_UNIT_FILE=/etc/systemd/system/worldfoundry-update.service
UPDATE_PATH_FILE=/etc/systemd/system/worldfoundry-update.path
CLI_LINK=/usr/local/bin/worldfoundry
SERVICE_USER=worldfoundry
# Default port ranges of the games (see installer/windows/worldfoundry.iss): Minecraft and Satisfactory on TCP,
# Satisfactory, ARK, Project Zomboid and the Steam query ports on UDP. RCON stays closed.
GAME_TCP_RANGES="25565-25575 7777-7790 8888-8899"
GAME_UDP_RANGES="7777-7790 16261-16280 27015-27030"

PORT=3000
OPEN_FIREWALL=0
START_SERVICE=1
UPGRADE=0

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Install or update WorldFoundry

  sudo ./install.sh [options]

  --port <port>      Web port on first installation (default 3000). On an update the configuration is kept.
  --open-firewall    Open the web port and the default game server ports in ufw or firewalld
                     (TCP 25565-25575, 7777-7790, 8888-8899; UDP 7777-7790, 16261-16280, 27015-27030)
  --no-start         Set up the service but do not start it
  --upgrade          Update an existing installation (used by the update service): no port, firewall or credentials
  -h, --help         this help
EOF
}

info() { printf '%s\n' "$*"; }
warn() { printf 'Note: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$#" -ge 2 ] || die "--port needs a value."
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#--port=}"
      shift
      ;;
    --open-firewall)
      OPEN_FIREWALL=1
      shift
      ;;
    --no-start)
      START_SERVICE=0
      shift
      ;;
    --upgrade)
      UPGRADE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown option: $1"
      ;;
  esac
done

case "$PORT" in
  '' | *[!0-9]*) die "Invalid port: $PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "Invalid port: $PORT"; fi

[ "$(id -u)" -eq 0 ] || die "Please run as root, for example: sudo ./install.sh"
[ "$(uname -s)" = "Linux" ] || die "This package is for Linux only."
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] ||
  die "systemd is required (systemctl not found or not active). Alternative: start the application by hand with node/node app/backend/dist/index.js."
for required in node/node app/backend/dist/index.js app/frontend/dist/index.html tools/setup-config.mjs tools/lan.mjs tools/updater.mjs tools/update-keys.json worldfoundry worldfoundry.service worldfoundry-update.service worldfoundry-update.path version.json; do
  [ -e "$SRC/$required" ] || die "The package is incomplete ($required is missing). Extract the archive again."
done

# Does the package match the processor architecture?
package_target="$(sed -n 's/.*"target": *"\([^"]*\)".*/\1/p' "$SRC/version.json" | head -n 1)"
case "$(uname -m)" in
  x86_64 | amd64) machine_target=linux-x64 ;;
  aarch64 | arm64) machine_target=linux-arm64 ;;
  *) machine_target="unknown ($(uname -m))" ;;
esac
[ "$package_target" = "$machine_target" ] ||
  die "This package is for $package_target, but this computer is $machine_target. Please use the matching archive."
"$SRC/node/node" --version >/dev/null 2>&1 ||
  die "The bundled Node executable cannot be started (a glibc-based Linux is required, e.g. Debian, Ubuntu, Fedora; Alpine is not supported)."

if [ "$UPGRADE" -eq 1 ]; then
  [ "$OPEN_FIREWALL" -eq 0 ] || die "--upgrade cannot be combined with --open-firewall."
  [ -f "$INSTALL_DIR/VERSION" ] || die "--upgrade is only meant for an existing installation."
  [ -f "$CONF_FILE" ] || die "--upgrade: the configuration $CONF_FILE is missing."
fi

new_version="$(tr -d '\r\n' <"$SRC/VERSION")"
old_version=""
[ -f "$INSTALL_DIR/VERSION" ] && old_version="$(tr -d '\r\n' <"$INSTALL_DIR/VERSION")"
if [ -n "$old_version" ]; then
  info "Updating WorldFoundry $old_version -> $new_version ..."
else
  info "Installing WorldFoundry $new_version ..."
fi

# System user without login
if ! getent group "$SERVICE_USER" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_USER"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  nologin="$(command -v nologin || true)"
  [ -n "$nologin" ] || nologin=/usr/sbin/nologin
  useradd --system --gid "$SERVICE_USER" --home-dir "$DATA_DIR" --no-create-home --shell "$nologin" \
    --comment "WorldFoundry" "$SERVICE_USER"
  info "System user $SERVICE_USER created."
fi

# Stop a running service (waits until the game servers have saved and stopped)
was_active=0
if systemctl is-active --quiet worldfoundry.service; then
  was_active=1
  info "Stopping the running service (game servers are shut down cleanly, this can take up to three minutes) ..."
  systemctl stop worldfoundry.service
fi

install -d -o root -g root -m 0755 /opt
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONF_DIR"
# Folder of the updater: owned by root (status.json, work and backup folders); only request/ is writable by the application
install -d -o root -g root -m 0755 "$UPDATE_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$UPDATE_ROOT/request"
install -d -o root -g root -m 0700 "$UPDATE_ROOT/work" "$UPDATE_ROOT/backup"

# Program files: copy into a new folder first, then swap (no half-finished update if interrupted)
staging="$INSTALL_DIR.new"
rm -rf "$staging" "$INSTALL_DIR.old"
mkdir -p "$staging"
cp -R "$SRC/node" "$SRC/app" "$SRC/tools" "$staging/"
for file in VERSION version.json LICENSE.txt THIRD-PARTY-NOTICES.txt README.txt uninstall.sh worldfoundry worldfoundry.service worldfoundry-update.service worldfoundry-update.path; do
  [ -f "$SRC/$file" ] && cp "$SRC/$file" "$staging/$file"
done
chown -R root:root "$staging"
chmod -R go-w "$staging"
chmod 0755 "$staging/node/node"
[ -f "$staging/uninstall.sh" ] && chmod 0755 "$staging/uninstall.sh"
chmod 0755 "$staging/worldfoundry"
if [ -d "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$INSTALL_DIR.old"; fi
mv "$staging" "$INSTALL_DIR"
rm -rf "$INSTALL_DIR.old"

# Create the configuration on first installation only
created=0
token=""
if [ ! -f "$CONF_FILE" ]; then
  output="$("$INSTALL_DIR/node/node" "$INSTALL_DIR/tools/setup-config.mjs" \
    --config "$CONF_FILE" --data-dir "$DATA_DIR" --servers-dir "$DATA_DIR/servers" --port "$PORT" --print-token)"
  case "$output" in
    *'"created":true'*) created=1 ;;
    *) die "The configuration could not be created." ;;
  esac
  token="$(printf '%s' "$output" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || die "The access token could not be generated."
elif [ "$PORT" != "3000" ]; then
  warn "The configuration $CONF_FILE already exists; --port is ignored. Change the port there (PORT=...)."
fi
chown root:"$SERVICE_USER" "$CONF_FILE"
chmod 0640 "$CONF_FILE"

# Admin command "sudo worldfoundry reset-password" (a foreign entry of the same name is left alone)
if [ ! -e "$CLI_LINK" ] && [ ! -L "$CLI_LINK" ] || [ "$(readlink "$CLI_LINK" 2>/dev/null)" = "$INSTALL_DIR/worldfoundry" ]; then
  install -d -m 0755 "$(dirname "$CLI_LINK")"
  ln -sfn "$INSTALL_DIR/worldfoundry" "$CLI_LINK"
else
  warn "$CLI_LINK already exists and was not replaced. The command is also available as $INSTALL_DIR/worldfoundry."
fi

# Set up the services
install -m 0644 -o root -g root "$INSTALL_DIR/worldfoundry.service" "$UNIT_FILE"
install -m 0644 -o root -g root "$INSTALL_DIR/worldfoundry-update.service" "$UPDATE_UNIT_FILE"
install -m 0644 -o root -g root "$INSTALL_DIR/worldfoundry-update.path" "$UPDATE_PATH_FILE"
systemctl daemon-reload
systemctl enable worldfoundry.service >/dev/null 2>&1
# The path trigger is already running when this script was started by the updater itself: do not restart it
systemctl enable worldfoundry-update.path >/dev/null 2>&1
systemctl start worldfoundry-update.path >/dev/null 2>&1 || warn "The update trigger worldfoundry-update.path could not be started."

configured_port="$(sed -n "s/^PORT=['\"]\{0,1\}\([0-9]\{1,5\}\).*/\1/p" "$CONF_FILE" | head -n 1)"
[ -n "$configured_port" ] || configured_port=3000

if [ "$START_SERVICE" -eq 1 ]; then
  systemctl restart worldfoundry.service
  healthy=0
  for _ in $(seq 1 30); do
    # Port and address may have been changed in the web interface: tools/lan.mjs --probe reads network.json
    probe_url="$("$INSTALL_DIR/node/node" "$INSTALL_DIR/tools/lan.mjs" --probe --data-dir "$DATA_DIR" --config "$CONF_FILE" 2>/dev/null || true)"
    [ -n "$probe_url" ] || probe_url="http://127.0.0.1:$configured_port"
    if "$INSTALL_DIR/node/node" -e "fetch('$probe_url/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ "$healthy" -eq 1 ]; then
    info "Service is running."
  else
    warn "The service is not responding yet. View the log with: journalctl -u worldfoundry -e"
  fi
elif [ "$was_active" -eq 1 ]; then
  warn "The service was running and stays stopped because of --no-start: sudo systemctl start worldfoundry"
fi

# Firewall (optional)
firewall_note=""
if [ "$OPEN_FIREWALL" -eq 1 ] && [ "$UPGRADE" -eq 0 ]; then
  : >"$FIREWALL_STATE.tmp"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$configured_port/tcp" comment 'WorldFoundry Web' >/dev/null
    printf 'ufw %s/tcp\n' "$configured_port" >>"$FIREWALL_STATE.tmp"
    for range in $GAME_TCP_RANGES; do
      ufw allow "$(printf '%s' "$range" | tr '-' ':')/tcp" comment 'WorldFoundry game servers' >/dev/null
      printf 'ufw %s/tcp\n' "$(printf '%s' "$range" | tr '-' ':')" >>"$FIREWALL_STATE.tmp"
    done
    for range in $GAME_UDP_RANGES; do
      ufw allow "$(printf '%s' "$range" | tr '-' ':')/udp" comment 'WorldFoundry game servers' >/dev/null
      printf 'ufw %s/udp\n' "$(printf '%s' "$range" | tr '-' ':')" >>"$FIREWALL_STATE.tmp"
    done
    firewall_note="ufw: web port TCP $configured_port and the game server ports opened."
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="$configured_port/tcp" >/dev/null
    printf 'firewalld %s/tcp\n' "$configured_port" >>"$FIREWALL_STATE.tmp"
    for range in $GAME_TCP_RANGES; do
      firewall-cmd --permanent --add-port="$range/tcp" >/dev/null
      printf 'firewalld %s/tcp\n' "$range" >>"$FIREWALL_STATE.tmp"
    done
    for range in $GAME_UDP_RANGES; do
      firewall-cmd --permanent --add-port="$range/udp" >/dev/null
      printf 'firewalld %s/udp\n' "$range" >>"$FIREWALL_STATE.tmp"
    done
    firewall-cmd --reload >/dev/null
    firewall_note="firewalld: web port TCP $configured_port and the game server ports opened."
  else
    firewall_note="No active firewall (ufw/firewalld) found, nothing changed."
  fi
  if [ -s "$FIREWALL_STATE.tmp" ]; then
    # keep earlier entries, avoid duplicates
    { [ -f "$FIREWALL_STATE" ] && cat "$FIREWALL_STATE"; cat "$FIREWALL_STATE.tmp"; } | sort -u >"$FIREWALL_STATE.new"
    mv "$FIREWALL_STATE.new" "$FIREWALL_STATE"
    chown root:root "$FIREWALL_STATE"
    chmod 0644 "$FIREWALL_STATE"
  fi
  rm -f "$FIREWALL_STATE.tmp"
fi

# Addresses: adapters with private addresses first, virtual adapters (Docker, VPN, WSL, ...) separately;
# the port is the one the application really listens on (it can be changed in the web interface)
web_port="$configured_port"
probe_url="$("$INSTALL_DIR/node/node" "$INSTALL_DIR/tools/lan.mjs" --probe --data-dir "$DATA_DIR" --config "$CONF_FILE" 2>/dev/null || true)"
[ -n "$probe_url" ] && web_port="${probe_url##*:}"
lan_text="$("$INSTALL_DIR/node/node" "$INSTALL_DIR/tools/lan.mjs" --text --data-dir "$DATA_DIR" --config "$CONF_FILE" 2>/dev/null | tr -d '\r' || true)"
if [ -z "$lan_text" ]; then
  # without output from Node: hostname -I, IPv4 only and without link-local addresses (169.254/16)
  lan_text="   http://localhost:$web_port"
  for address in $(hostname -I 2>/dev/null || true); do
    case "$address" in
      *:* | 169.254.*) ;;
      *) lan_text="   http://$address:$web_port
$lan_text" ;;
    esac
  done
fi

info ""
info "=============================================================="
if [ "$created" -eq 1 ]; then
  info " WorldFoundry $new_version is installed."
else
  info " WorldFoundry has been updated to $new_version."
fi
info "=============================================================="
info " The web interface is available at:"
info "$lan_text"
info " (Assign a fixed address in your router so it does not change, e.g. on a FRITZ!Box: Home Network > Network > edit device)"
if [ "$created" -eq 1 ]; then
  info ""
  info " Access token (for signing in, also the first password):"
  info "   $token"
  info ""
  info " The token is also stored in $CONF_FILE (readable by root and the group $SERVICE_USER only):"
  info "   sudo grep AUTH_TOKEN $CONF_FILE"
  info " You can set your own password in the web interface under System."
  info " Forgot the password:  sudo worldfoundry reset-password"
fi
info ""
info " Data and servers:  $DATA_DIR"
info " Configuration:     $CONF_FILE"
info " Log:               journalctl -u worldfoundry -f"
info " Ports:             web TCP $web_port; each game server shows its ports on its page"
[ -n "$firewall_note" ] && info " Firewall:          $firewall_note"
if [ "$OPEN_FIREWALL" -eq 0 ] && [ "$UPGRADE" -eq 0 ]; then
  info " Firewall:          unchanged (use --open-firewall or open the ports by hand)"
fi
info ""
info " NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT."
info "=============================================================="
