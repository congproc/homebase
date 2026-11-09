#!/usr/bin/env bash
# Remove Homebase for the current user.
#   ./uninstall.sh            stop and remove the user service and the installed copy (keeps your settings)
#   ./uninstall.sh --purge    also delete ~/.config/homebase and Homebase's alert history
# The optional root integration is removed separately:
#   sudo python3 <install dir>/system/install-power.py --uninstall
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/homebase.service"
APP=""
[ -f "$UNIT" ] && APP="$(sed -n 's/^WorkingDirectory=//p' "$UNIT")"

systemctl --user disable --now homebase.service 2>/dev/null || true
rm -f "$UNIT"
rm -rf "${UNIT}.d"
systemctl --user daemon-reload

# Only remove a copied install, never a source checkout installed with --in-place.
if [ -n "$APP" ] && [ -f "$APP/server/index.mjs" ] && [ ! -e "$APP/package-lock.json" ] && [ ! -d "$APP/src" ]; then
  rm -rf "$APP"
  echo "Removed $APP"
elif [ -n "$APP" ]; then
  echo "Left $APP in place (source checkout)."
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/homebase" "$HOME/.local/state/homebase"
  echo "Removed settings and alert history."
fi
echo "Homebase user service removed."
if [ -x /usr/local/sbin/homebase-power ]; then
  echo "Root integration is still installed. Remove it with:"
  echo "  sudo python3 ${APP:-<install dir>}/system/install-power.py --uninstall"
fi
if command -v tailscale >/dev/null && tailscale serve status 2>/dev/null | grep -q ':8443'; then
  echo "Tailscale still publishes port 8443. Remove only that route with: tailscale serve --https=8443 off"
fi
