# Homebase

A private dashboard and control panel for one Linux home server: CPU, memory, drives (health, temperature, throughput, filesystems) and network, Docker containers, tmux sessions, Claude Code / Codex / Ollama, systemd services, visitor traffic for your own sites, wall power and electricity cost from a Tapo smart plug, and a smart nightly sleep schedule with RTC wake. Pages for things a machine doesn't have (no Docker, no GPU, no plug…) hide themselves.

It runs as an unprivileged **user** service, listens only on `127.0.0.1`, and has no npm runtime dependencies — a release needs nothing but Node.js on the target machine.

## Install on a machine

Requirements: Linux with systemd, Node.js **22.13+**. Optional: Docker, tmux, Ollama, Tailscale, `nvidia-smi` for NVIDIA GPUs, `smartmontools` for drive health (missing tools simply show as unavailable). AMD and Intel GPUs need nothing extra.

One line (downloads the latest release, verifies its checksum, and fetches Node.js 24 into the install folder if the machine has no Node.js 22.13+):

```sh
curl -fsSL https://raw.githubusercontent.com/congproc/homebase/main/get.sh | bash
```

Run as your normal user (not root). Re-run the same line to upgrade. Pass options after `bash -s --`, e.g. `... | bash -s -- --tailscale --port 8790`; `--no-linger` skips start-at-boot. Read [`get.sh`](get.sh) first if you prefer.

With git (no npm needed — the built dashboard is committed):

```sh
git clone https://github.com/congproc/homebase.git
cd homebase
./install.sh --linger          # copy to ~/.local/share/homebase, start it, and start at boot
```

Upgrade later with the **Update** button that appears in the dashboard's top bar when a new release is out, or with `cd homebase && git pull && ./install.sh` (settings are kept).

Or from a release tarball (Releases page):

```sh
sha256sum -c homebase-1.7.0.tar.gz.sha256
tar xzf homebase-1.7.0.tar.gz && cd homebase-1.7.0
./install.sh --linger
```

No Node.js 22.13+? The quickest way is [nvm](https://github.com/nvm-sh/nvm): `nvm install 24`. If the service can't find it, run `HOMEBASE_NODE=$(which node) ./install.sh --linger`.

Homebase listens only on `127.0.0.1`. From another computer use an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 you@server`) or `--tailscale` below.

Open http://127.0.0.1:8787. Useful options (`./install.sh --help`):

| Option | Effect |
|---|---|
| `--port N` | listen on another loopback port |
| `--in-place` | run from the current directory instead of copying (used for a development checkout) |
| `--linger` | keep running while you are logged out / start at boot (`loginctl enable-linger`) |
| `--tailscale` | record this device's tailnet origin and login, and publish with `tailscale serve --https=8443` (tailnet-only, never Funnel) |
| `--with-power` | afterwards, install the root integration below (asks for your sudo password) |

Re-running `install.sh` upgrades in place and keeps your settings. Remove with `./uninstall.sh` (add `--purge` to delete settings and alert history).

### Optional root integration (sleep schedule, system services, SMART, desktop on/off)

Nightly smart sleep, start/stop of system services, SMART drive health and turning the desktop on/off need a one-time root setup. Review `system/` first, then:

```sh
python3 system/install-power.py --check --user "$USER"   # validate only, changes nothing
sudo python3 system/install-power.py --user "$USER"
```

It installs a fixed-purpose root helper (`/usr/local/sbin/homebase-power`: strict JSON schema, no shell), the busy check and night controller scripts, the `server-night-sleep` timer/service, and a sudoers rule that lets **only that account** run the helper without a password. The helper's `smart <disk>` operation is read-only, accepts only whole-disk names, returns a fixed subset of `smartctl` output, and skips drives in standby so it never spins them up. Existing files are backed up to `/var/backups/homebase-power/<timestamp>/`, the sudoers file is validated with `visudo` before it goes live, and nothing suspends during installation. On a new machine nightly sleep starts **disabled** — turn it on in **Sleep & power**. Remove with `sudo python3 system/install-power.py --uninstall`.

The night controller skips the night if the server is busy (CPU ≥ 15 %, network ≥ 1 MiB/s, busy containers, backups/transfers, NVIDIA compute jobs or an AMD/Intel GPU ≥ 30 % busy, sleep inhibitors, and optionally SSH sessions, non-shell tmux panes or selected services), arms an RTC alarm for the wake time, suspends, and restores everything on resume. If `sleep.target` was masked (an always-on server), it is masked again after resume. Details: `docs/SLEEP-HANDOFF.md`.

## Development

```sh
npm ci
npm run dev        # live-reload dashboard + server
npm test && npm run typecheck && npm run lint
npm run build      # rebuild dist/ — commit it, since git installs use it
npm run package    # release/homebase-<version>.tar.gz
```

## Configuration

Machine-specific settings live in `~/.config/homebase/config.json` (or `$HOMEBASE_CONFIG`), created from `config.example.json` on first install:

```jsonc
{
  "port": 8787,
  "services": {                                   // labels and health probes; order = display order
    "user:finance.service": {"name": "Finance", "description": "Personal finance tracker", "port": 8000,
                             "remoteUrl": "https://{hostname}"},   // link shown when opened over the tailnet
    "user:shop.service": {"name": "Shop", "port": 8790, "probe": "tcp"} // tcp: don't log a probe as a visitor
  },
  "hiddenUnits": ["cloud-init"],                  // unit-name prefixes to leave out of Hosted services
  "updates": {"check": true},                     // look for new releases on GitHub (Hosts → Homebase)
  "tailscale": {"origin": "https://host.tailnet.ts.net:8443", "login": "you@example.com"},
  "traffic": {
    "logDir": "~/.local/state/homebase-sites",    // where your sites write <prefix>-YYYY-MM-DD.jsonl
    "controlFile": "~/.config/homebase/access-control.json",
    "sites": [{"id": "shop", "name": "Shop", "unit": "shop.service", "port": 8790, "prefix": "access"}]
  }
}
```

Optional sections (leave them out if they don't apply):

```jsonc
{
  "energy": {                                     // power monitoring: see Energy below
    "tapo": {"host": "192.168.1.50", "email": "you@example.com", "password": "your-tapo-password"},
    "tariff": "evn", "vat": 0.08, "householdKwh": 250
  },
  "features": {"docker": false, "gpu": true}       // force a dashboard feature off or on (normally detected)
}
```

Restart after editing: `systemctl --user restart homebase`. `HOMEBASE_PORT`, `HOMEBASE_TAILSCALE_ORIGIN` and `HOMEBASE_TAILSCALE_LOGIN` environment variables override the file.

Traffic is opt-in: each site writes one JSON object per request (`t` ISO time, `ip`, `ua`, `m`, `p`, `s` status, `b` bytes, `src` `local|tailnet|funnel`, optional 12-hex `sid` session hash — never cookies or passwords) and re-reads the control file for sign-outs and IP blocks.

## Access and security model

- **Loopback only.** The server binds `127.0.0.1`. Every request's TCP peer is resolved to its owning Unix account (`/proc/net/tcp`); only the account running Homebase is accepted. Other local accounts and host-network containers get `403` even with a forged `Host`.
- **Tailnet access** (optional) is accepted only from `tailscaled` on the configured `*.ts.net` origin, and only when Tailscale Serve's `Tailscale-User-Login` header names the configured login. A loopback `Host` sent through Serve is refused.
- **Mutations** additionally require a per-process token, a JSON body, and a same-origin `Origin` when present. All commands are allowlisted and run with argument arrays — there is no shell endpoint. Docker, tmux, agent and service actions are bound to the current inventory.
- **Browser hardening:** strict `Content-Security-Policy` (`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `no-referrer`, COOP/CORP same-origin.
- Do not expose Homebase through a public reverse proxy or Tailscale Funnel. Without Tailscale, use an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 you@server`.


## Features

- **Overview / Resources:** live CPU, memory, disk, network every 5 s with a 15-minute history (paused while no dashboard is open; gaps are shown as breaks), health summary, top processes.
- **Storage:** every physical drive (SATA, NVMe, USB, virtual) with model, serial, firmware and PCIe link, temperature from the drive's own sensors, live read/write throughput, IOPS and busy %, a 15-minute I/O chart, partitions with mount points and usage (including LVM/LUKS volumes), and SMART health — pass/fail, wear / life left, power-on time, bad and pending sectors, media errors, lifetime bytes written. Capacity, temperatures and I/O need no root; SMART needs `smartmontools` and the root integration (re-run `install-power.py` to add it). Failing drives and high temperatures also raise the overall health level.
- **Updates:** when a newer release is on GitHub, an **Update** button appears in the top bar and an **UPDATE** badge in the sidebar; **Hosts → Homebase** (or click the version in the sidebar) shows the installed version, release notes and *Check now*. Homebase checks at start and every 12 h — set `"updates": {"check": false}` to turn that off; then only *Check now* contacts GitHub. Updating keeps your settings, restarts Homebase and reloads the page:
  - **Installed copy** (one-liner or tarball): downloads the release, verifies its SHA-256 and runs its `install.sh`.
  - **Git checkout** (`--in-place`): `git pull --ff-only`, then `./install.sh --in-place`. Refused while tracked files have uncommitted changes, so local work is never overwritten.

  The installer runs in a separate systemd unit so the restart can't interrupt it; its log is `~/.local/state/homebase/update.log`, and if it fails the previous version keeps running. When the root-installed sleep scripts differ from the running version, the panel shows the `sudo` command that refreshes them.
- **GPU:** NVIDIA (via `nvidia-smi`), AMD (`amdgpu`) and Intel integrated or Arc (`i915` / `xe`) — utilization, VRAM, temperature, power, fan and clocks where the driver exposes them, a 15-minute chart per GPU, and the processes using it. AMD/Intel readings come straight from sysfs without root; Intel utilization is the share of time the GPU was out of its idle (RC6) state, and per-process use (DRM fdinfo) covers processes of the account running Homebase. Integrated GPUs share system memory, so no VRAM is shown for them.
- **Hosts:** machine details, sleep periods since boot, interfaces, and **Features on this machine**: which optional parts of the dashboard apply here and why. Containers, Tmux, AI services (and each agent), Traffic, Energy and GPU appear only when detected — the tool is installed, the site or plug is configured, the hardware is present. Detection looks at installation, not momentary state, so a stopped Docker daemon doesn't make the page vanish. Override with `"features": {"<id>": true|false}` (`docker`, `tmux`, `ai`, `traffic`, `energy`, `gpu`).
- **Energy** (needs a TP-Link Tapo P110 / P110M / P115 plug the server is plugged into): live watts, energy today and this month, a 24-hour chart of 5-minute readings, and hourly, daily and monthly bars — all read from the plug's own meter over the LAN (KLAP protocol, no cloud), so they cover time the dashboard was closed and the server slept. Turn on **Third-Party Compatibility** in the Tapo app (Me → Third-Party Services) and use the Tapo account login. The email and password stay on the server; only the plug's address reaches the dashboard.
  - **Cost:** `"tariff": "evn"` uses the built-in EVN residential 5-tier tariff (from 1 Nov 2026, before VAT; `"vat"` defaults to 8 %). Because tiered prices depend on the whole meter, the server's kWh are priced on top of `"householdKwh"` (your usual monthly use, server included) — what the bill drops by if the server were off. Use your own tiers with `"tariff": {"tiers": [[100, 1901], [null, 2289]], "vat": 0.1, "currency": "VND"}`, or a flat `"pricePerKwh"` and `"currency"`.
  - **Estimate:** first as if the server ran 24/7 at its measured awake power; meanwhile a once-a-minute heartbeat logs when the machine is awake (`~/.local/state/homebase/energy-log.json`). After the first full day a provisional prediction from the real on-time and the plug's daily energy appears, and after 7 days it becomes the main figure.
- **Containers:** start, stop, restart, last 80 log lines (stop/restart confirm first).
- **Tmux sessions:** create (in their own systemd scope, so they survive Homebase restarts), preview, kill, copy attach command.
- **AI services:** Claude Code / Codex sessions (start in tmux, stop), Ollama service and loaded models.
- **Hosted services:** custom user units and system units with health checks, start/stop/restart, per-service "prevent sleep".
- **Traffic:** devices, sign-ins, security alerts (unread ones lead the page; handled ones move below the numbers) (failed or rate-limited sign-ins, new public devices — checked every 20 s even with no dashboard open), sign out / block IP, heatmap, Tailscale routes and devices.
- **Sleep & power:** timeline, last nightly result, schedule and safeguards side by side, and a **Desktop (GUI)** switch: turn the graphical desktop off (boots to text mode, frees its memory and the GPU; SSH, Tailscale, services and tmux keep running) or back on. Needs the root integration.
- Keyboard: `Ctrl K` command palette, `1`–`9`/`0` the first ten visible pages, `R` refresh. Installable as an app (PWA manifest). The favicon and logo status light turn amber/red when the server needs attention.

## Development

```sh
npm ci
npm run dev          # Vite on http://127.0.0.1:5173 + the agent on 8787
npm test             # node + python test suites
npm run typecheck && npm run lint
npm run build        # dist/
npm run package      # release/homebase-<version>.tar.gz + .sha256
```

Layout: `server/` (dependency-free Node agent), `app/` + `src/` + `components/ui/` (React 19 + Vite + Tailwind 4 frontend), `system/` (root integration), `brand/` (logo masters and icon exports), `tests/`.

## Brand

The mark is a lowercase **h** whose counter is a lit doorway; the dot is the wordmark's period and the live status light. In the dashboard the dot follows system health (ink when normal, amber when something needs attention, red and pulsing when critical or disconnected), and so does the browser-tab favicon. Masters and exports live in `brand/`. Colours: lime `#d1ee97`, ink `#101113`. Keep clear space of one stem width around the mark; don't use the regular cut below 24 px (use `homebase-symbol-small.svg`).

## License

[MIT](LICENSE) © 2026 congproc. `vendor/` keeps its own upstream license.
