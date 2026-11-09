#!/usr/bin/env bash
# Install Homebase for the current user on a Linux machine with systemd.
#
#   ./install.sh                     copy to ~/.local/share/homebase and start it as a user service
#   ./install.sh --in-place          run from this directory instead of copying
#   ./install.sh --port 8790         listen on another loopback port (default 8787)
#   ./install.sh --linger            keep running when you are logged out (loginctl enable-linger)
#   ./install.sh --tailscale         record this machine's tailnet origin/login and publish it with
#                                    `tailscale serve` on https port 8443 (private to your tailnet)
#   ./install.sh --with-power        afterwards, run the root setup for sleep scheduling and
#                                    system-service control (asks for your sudo password)
#
# Requirements: Linux, systemd user session, Node.js 22.13+. Docker, tmux, Ollama and Tailscale
# are optional; whatever is missing is shown as unavailable in the dashboard.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${HOMEBASE_PREFIX:-$HOME/.local/share/homebase}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/homebase"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
IN_PLACE=0 START=1 LINGER=0 TAILSCALE=0 POWER=0 PORT=""

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\033[1;32m›\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift ;;
    --in-place) IN_PLACE=1 ;;
    --port) PORT="$2"; shift ;;
    --no-start) START=0 ;;
    --linger) LINGER=1 ;;
    --tailscale) TAILSCALE=1 ;;
    --with-power) POWER=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

[ "$(uname -s)" = Linux ] || die "Homebase needs Linux (it reads /proc and uses systemd)."
[ "$(id -u)" -ne 0 ] || die "run as your normal user, not root; the root parts are installed separately with --with-power."
command -v systemctl >/dev/null || die "systemd is required."
systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user session (log in normally, or run: loginctl enable-linger $USER)."
if [ -n "$PORT" ]; then [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "invalid port $PORT"; fi

NODE="${HOMEBASE_NODE:-$(command -v node || true)}"
[ -n "$NODE" ] || die "Node.js 22.13+ is required (set HOMEBASE_NODE=/path/to/node if it is not on PATH)."
NODE="$(readlink -f "$NODE")"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js 22.13+ is required (found $("$NODE" --version))."

# Build the frontend only when installing from a source checkout without dist/.
if [ ! -f "$SRC/dist/index.html" ]; then
  [ -d "$SRC/node_modules" ] || die "dist/ is missing. Use a release tarball, or run: npm ci && npm run build"
  say "Building the dashboard"
  (cd "$SRC" && "$NODE" node_modules/vite/bin/vite.js build >/dev/null)
fi

if [ "$IN_PLACE" -eq 1 ]; then
  APP="$SRC"
else
  APP="$PREFIX"
  [ "$APP" != "$SRC" ] || die "--prefix is the source directory; use --in-place instead."
  say "Installing to $APP"
  mkdir -p "$APP"
  rm -rf "$APP/server" "$APP/dist" "$APP/system"
  cp -R "$SRC/server" "$SRC/dist" "$SRC/system" "$APP/"
  for f in install.sh uninstall.sh config.example.json package.json README.md; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$APP/"
  done
  chmod 755 "$APP/install.sh" "$APP/uninstall.sh" "$APP/system/install-power.py"
fi

mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
CONFIG="$CONFIG_DIR/config.json"
if [ ! -f "$CONFIG" ]; then
  say "Creating $CONFIG"
  install -m 600 "$SRC/config.example.json" "$CONFIG"
fi
# Small JSON edits go through Node so the config stays valid.
config_set() {
  "$NODE" -e 'const fs=require("fs"),[f,k,v]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(f,"utf8"));
    let o=c;const ks=k.split(".");for(const p of ks.slice(0,-1))o=o[p]??={};o[ks.at(-1)]=JSON.parse(v);
    fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n",{mode:0o600});' "$CONFIG" "$1" "$2"
}
[ -z "$PORT" ] || config_set port "$PORT"
PORT="$("$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||8787)' "$CONFIG")"

if [ "$TAILSCALE" -eq 1 ]; then
  command -v tailscale >/dev/null || die "--tailscale: tailscale is not installed."
  read -r TS_HOST TS_LOGIN < <(tailscale status --json | "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    const u=j.User?.[j.Self.UserID];console.log(j.Self.DNSName.replace(/\.$/,""),u?.LoginName||"")})') \
    || die "--tailscale: could not read tailscale status (is it logged in?)."
  [ -n "$TS_LOGIN" ] || die "--tailscale: this device has no user login (tagged devices are not supported)."
  config_set tailscale "{\"origin\":\"https://$TS_HOST:8443\",\"login\":\"$TS_LOGIN\"}"
  say "Tailnet access: https://$TS_HOST:8443 (only $TS_LOGIN)"
  if ! tailscale serve --bg --https=8443 "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "  Could not run tailscale serve as $USER. Run it once yourself:"
    echo "    sudo tailscale serve --bg --https=8443 http://127.0.0.1:$PORT"
  fi
fi

say "Writing user service $UNIT_DIR/homebase.service"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/homebase.service" <<UNIT
[Unit]
Description=Homebase server dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
ExecStart=$NODE $APP/server/index.mjs
Environment=PATH=$(dirname "$NODE"):$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=HOMEBASE_CONFIG=$CONFIG
UMask=0077
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable homebase.service >/dev/null

if [ "$START" -eq 1 ]; then
  systemctl --user restart homebase.service
  for _ in $(seq 1 20); do
    if "$NODE" -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "http://127.0.0.1:$PORT/" 2>/dev/null; then OK=1; break; fi
    sleep 0.5
  done
  [ "${OK:-0}" -eq 1 ] || die "Homebase did not start; see: journalctl --user -u homebase -n 50"
  say "Homebase is running: http://127.0.0.1:$PORT"
fi

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
  if [ "$LINGER" -eq 1 ]; then
    loginctl enable-linger "$USER" && say "Homebase will now start at boot, even before you log in."
  else
    echo "  Note: Homebase runs only while you are logged in. To start it at boot: loginctl enable-linger $USER"
  fi
fi

POWER_CMD="sudo python3 $APP/system/install-power.py --user $USER"
if [ "$POWER" -eq 1 ]; then
  say "Installing the root integration (sleep scheduling, system services)"
  $POWER_CMD
else
  echo "  Optional: sleep scheduling and system-service control need a one-time root setup:"
  echo "    $POWER_CMD"
fi
echo "  Settings: $CONFIG   Logs: journalctl --user -u homebase"
