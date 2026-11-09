#!/usr/bin/env bash
# One-line installer for Homebase:
#
#   curl -fsSL https://raw.githubusercontent.com/congproc/homebase/main/get.sh | bash
#
# Options go after `bash -s --`, e.g.  ... | bash -s -- --tailscale --port 8790
# Every install.sh option works (--port N, --tailscale, --with-power, --no-start, ...), plus:
#   --no-linger      don't start Homebase at boot (default: start at boot, also when logged out)
#   --version vX.Y.Z install that release instead of the latest
#
# What it does: downloads the latest release from GitHub, checks its SHA-256, and runs install.sh
# as you (never root). If Node.js 22.13+ is missing, it downloads the official Node.js build from
# nodejs.org (checksum-verified) into ~/.local/share/homebase/node — nothing system-wide changes.
# Re-run the same command to upgrade; settings are kept.
set -euo pipefail

REPO="congproc/homebase"
tmp=""
NODE_LINE="24"   # Node.js major line used when the machine has no suitable Node

main() {
  say() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
  die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
  fetch() { if command -v curl >/dev/null; then curl -fsSL --retry 3 "$1"; else wget -qO- "$1"; fi; }
  download() { if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -qO "$2" "$1"; fi; }

  local version="" linger=1 args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-linger) linger=0 ;;
      --version) [ $# -ge 2 ] || die "--version needs a value, e.g. v1.3.0"; version="$2"; shift ;;
      --in-place) die "--in-place is for a git checkout; use: git clone https://github.com/$REPO && cd homebase && ./install.sh --in-place" ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  [ "$linger" -eq 1 ] && args+=(--linger)

  [ "$(uname -s)" = Linux ] || die "Homebase needs Linux."
  [ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root (no sudo). Root parts are optional and asked for separately."
  command -v systemctl >/dev/null || die "systemd is required."
  command -v curl >/dev/null || command -v wget >/dev/null || die "curl or wget is required."
  for t in tar sha256sum gzip; do command -v "$t" >/dev/null || die "$t is required."; done

  local prefix="${HOMEBASE_PREFIX:-$HOME/.local/share/homebase}"
  tmp="$(mktemp -d)"   # global: the EXIT trap runs after main returns
  trap 'rm -rf "$tmp"' EXIT

  # ---- Node.js ----
  local node="${HOMEBASE_NODE:-}"
  node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
  if [ -z "$node" ]; then
    if [ -x "$prefix/node/bin/node" ] && node_ok "$prefix/node/bin/node"; then node="$prefix/node/bin/node"
    elif command -v node >/dev/null && node_ok "$(command -v node)"; then node="$(command -v node)"
    fi
  fi
  if [ -z "$node" ]; then
    local arch
    case "$(uname -m)" in
      x86_64|amd64) arch=x64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) die "no suitable Node.js found and no official build for $(uname -m); install Node.js 22.13+ and re-run." ;;
    esac
    say "Node.js 22.13+ not found — downloading Node.js $NODE_LINE for linux-$arch"
    local base="https://nodejs.org/dist/latest-v${NODE_LINE}.x"
    fetch "$base/SHASUMS256.txt" > "$tmp/node.sums" || die "could not reach nodejs.org"
    local file; file="$(grep -m1 -oE "node-v[0-9.]+-linux-${arch}\.tar\.gz$" "$tmp/node.sums")"
    [ -n "$file" ] || die "could not find a Node.js build for linux-$arch"
    download "$base/$file" "$tmp/$file"
    (cd "$tmp" && grep " $file\$" node.sums | sha256sum -c --status) || die "Node.js download failed its checksum"
    mkdir -p "$prefix"
    rm -rf "$prefix/node" && mkdir -p "$prefix/node"
    tar xzf "$tmp/$file" -C "$prefix/node" --strip-components=1
    node="$prefix/node/bin/node"
    node_ok "$node" || die "the downloaded Node.js does not run on this machine"
  fi
  say "Using Node.js $("$node" --version) ($node)"

  # ---- Homebase release ----
  if [ -z "$version" ]; then
    # Read the whole response first: grep -m1 on a pipe would cut curl off mid-write (SIGPIPE) and pipefail aborts.
    local release
    release="$(fetch "https://api.github.com/repos/$REPO/releases/latest")" || die "could not look up the latest release on GitHub"
    version="$(sed -nE '/"tag_name"/{s/.*"tag_name": *"([^"]+)".*/\1/p;q}' <<< "$release")"
    [ -n "$version" ] || die "could not look up the latest release on GitHub"
  fi
  local name="homebase-${version#v}"
  say "Downloading Homebase ${version}"
  download "https://github.com/$REPO/releases/download/$version/$name.tar.gz" "$tmp/$name.tar.gz" || die "release $version not found"
  download "https://github.com/$REPO/releases/download/$version/$name.tar.gz.sha256" "$tmp/$name.tar.gz.sha256" || die "checksum for $version not found"
  (cd "$tmp" && sha256sum -c --status "$name.tar.gz.sha256") || die "download failed its checksum — not installing"
  tar xzf "$tmp/$name.tar.gz" -C "$tmp"

  HOMEBASE_NODE="$node" HOMEBASE_PREFIX="$prefix" bash "$tmp/$name/install.sh" ${args[@]+"${args[@]}"}
  echo "  Upgrade: re-run the same command.  Remove: $prefix/uninstall.sh"
}

main "$@"   # everything above is only defined until here, so a cut-off download can't run half a script
