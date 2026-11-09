# Nightly Smart Suspend + RTC Wake — Handoff

Reproduces the setup from the original server (Ubuntu 26.04 LTS): the server
suspends at a set time each night **only if idle**, then wakes itself at a set
time via the hardware RTC alarm. Outside that window, suspend is fully disabled
so the box behaves like a normal always-on server.

Current settings on the source machine:

| Setting     | Value  |
|-------------|--------|
| Sleep time  | 00:30  |
| Wake time   | 05:00  |
| Block on SSH sessions  | no  |
| Block on busy tmux     | no  |
| Extra blocking services | none |

---

## 1. How it works

```
server-night-sleep.timer (00:30 daily)
  └─ server-night-sleep.service (oneshot)
       └─ /usr/local/sbin/server-night-sleep
            ├─ /usr/local/sbin/server-smart-sleep   → busy? exit, skip tonight
            ├─ homebase-power wake-time             → reads /etc/homebase/power.json
            ├─ rtcwake -m no -t <next wake>         → arm RTC alarm
            ├─ systemctl unmask sleep/suspend.target
            ├─ systemctl start --wait suspend.target  (blocks until resume)
            └─ trap on EXIT: re-mask targets, clear RTC alarm
```

Pieces:

| File | Role |
|------|------|
| `/etc/systemd/system/server-night-sleep.timer` | Fires nightly |
| `/etc/systemd/system/server-night-sleep.timer.d/homebase.conf` | Overrides `OnCalendar` with the configured sleep time (written by `homebase-power apply`) |
| `/etc/systemd/system/server-night-sleep.service` | Oneshot that runs the controller |
| `/usr/local/sbin/server-night-sleep` | Controller: check → arm RTC → suspend → restore |
| `/usr/local/sbin/server-smart-sleep` | Idle check, exit 0 = safe, 1 = busy |
| `/usr/local/sbin/homebase-power` | Root-owned helper that reads/validates/applies `/etc/homebase/power.json` |
| `/etc/homebase/power.json` | Policy (times, toggles, blocking services) |
| `/etc/sudoers.d/homebase-power` | *Optional*: lets the Homebase dashboard run `homebase-power apply` without a password |
| `/usr/local/sbin/server-suspend-test` | Manual 2-minute suspend/wake test |

**Masked targets (permanent "server mode"):**
`sleep.target`, `suspend.target`, `hibernate.target`, `hybrid-sleep.target`
are all symlinked to `/dev/null`. The controller unmasks only `sleep` +
`suspend` for the duration of the nightly suspend.

### Busy conditions (any one skips suspend)

- A service listed in `power.json` → `services` is active
- Override file `~/.local/state/server/stay-awake-tonight` exists
- Any `systemd-inhibit` **block** lock for `sleep`
- Running `rsync`, `rclone`, `scp`, `sftp`, `borg`, or `restic`
- Any NVIDIA compute process (`nvidia-smi`; ignored if not installed)
- A tmux pane running a non-shell command (if `blockTmux`)
- An established SSH connection on port 22 (if `blockSsh`)
- A Docker container at ≥10% CPU
- System CPU ≥15% over a 5 s sample
- Default-interface network ≥1 MiB/s over 5 s

A config read error in `homebase-power` exits with code 2, which the scripts
treat as "busy". A broken config never lets the machine suspend.

---

## 2. Prerequisites on the target server

```bash
sudo apt install util-linux iproute2 procps python3 tmux   # rtcwake, ss, pgrep
```

Check that the hardware can do it:

```bash
ls /sys/class/rtc/rtc0/wakealarm      # must exist
cat /sys/power/mem_sleep              # [deep] preferred; s2idle may not wake on RTC on some boards
timedatectl | grep 'RTC in local TZ'  # should be "no" (RTC in UTC)
```

In BIOS/UEFI, enable "Wake on RTC" or "Resume by Alarm" if the board has it.
Also turn off "ErP"/deep-S5 power saving if the RTC alarm doesn't fire.

### Values to change for the new machine

| Where | Variable | Source value |
|-------|----------|--------------|
| `server-smart-sleep` | `USER_NAME`, `HOME_DIR` | `youruser`, `/home/youruser` |
| `homebase-power` | `USER`, `UID` | `youruser`, `1000` |
| `homebase-power.sudoers` | username | `youruser` |
| `server-smart-sleep` | SSH port in `ss` filter | `22` |

Find the target user's UID with `id -u <user>`.

---

## 3. Install

Run everything as root (`sudo -i`). Every heredoc is quoted (`'EOF'`), so
paste them exactly as written.

### 3.1 Policy file

```bash
mkdir -p /etc/homebase
tee /etc/homebase/power.json >/dev/null <<'EOF'
{
  "enabled": true,
  "sleepTime": "00:30",
  "wakeTime": "05:00",
  "blockSsh": false,
  "blockTmux": false,
  "services": {}
}
EOF
chmod 644 /etc/homebase/power.json
```

`services` entries look like `"system:jellyfin.service": true` or
`"user:syncthing.service": true`. While a listed unit is active, suspend is
blocked.

### 3.2 `/usr/local/sbin/homebase-power`

```bash
tee /usr/local/sbin/homebase-power >/dev/null <<'EOF'
#!/usr/bin/python3
"""Fixed-purpose, root-owned bridge for Homebase's nightly sleep policy."""
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

CONFIG = pathlib.Path('/etc/homebase/power.json')
DROPIN = pathlib.Path('/etc/systemd/system/server-night-sleep.timer.d/homebase.conf')
LOCK = pathlib.Path('/run/lock/homebase-power.lock')
USER = 'youruser'   # CHANGE ME
UID = 1000             # CHANGE ME
DEFAULT = {'enabled': True, 'sleepTime': '00:30', 'wakeTime': '05:00', 'blockSsh': True, 'blockTmux': True, 'services': {}}
UNIT = re.compile(r'(user|system):([A-Za-z0-9_.@-]+\.service)\Z')
TIME = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d\Z')

def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT):
        raise ValueError('Unexpected settings fields')
    for key in ('enabled', 'blockSsh', 'blockTmux'):
        if type(value[key]) is not bool:
            raise ValueError(key + ' must be a boolean')
    for key in ('sleepTime', 'wakeTime'):
        if not isinstance(value[key], str) or not TIME.fullmatch(value[key]):
            raise ValueError('Use HH:MM for ' + key)
    if value['sleepTime'] == value['wakeTime']:
        raise ValueError('Sleep and wake times must differ')
    if not isinstance(value['services'], dict) or len(value['services']) > 100:
        raise ValueError('Invalid service preferences')
    for key, flag in value['services'].items():
        if not UNIT.fullmatch(key) or type(flag) is not bool:
            raise ValueError('Invalid service preference')
    return value

def read_config():
    return validate(json.loads(CONFIG.read_text()))

def run(args, check=True):
    return subprocess.run(args, text=True, capture_output=True, timeout=15, check=check)

def systemctl(scope, *args):
    if scope == 'user':
        prefix = ['/usr/sbin/runuser', '-u', USER, '--', '/usr/bin/env', f'XDG_RUNTIME_DIR=/run/user/{UID}', f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{UID}/bus', '/usr/bin/systemctl', '--user'] if os.geteuid() == 0 else ['/usr/bin/systemctl', '--user']
    else:
        prefix = ['/usr/bin/systemctl']
    return run(prefix + list(args), check=False)

def service_blockers(config):
    blockers = []
    for key, selected in config['services'].items():
        if not selected:
            continue
        scope, unit = UNIT.fullmatch(key).groups()
        result = systemctl(scope, 'show', unit, '--property=ActiveState', '--value')
        state = result.stdout.strip()
        if result.returncode or not state:
            blockers.append(f'Unable to check selected service: {key}')
        elif state in ('active', 'activating', 'reloading', 'deactivating'):
            blockers.append(f'Service prevents sleep: {key} ({state})')
    return blockers

def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.homebase-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def apply(config):
    validate(config)
    if os.geteuid() != 0:
        raise ValueError('Installation requires administrator privileges')
    # Serialize dashboard saves. Never execute service names or user input as shell code.
    with open(LOCK, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = CONFIG.read_text() if CONFIG.exists() else None
        old_dropin = DROPIN.read_text() if DROPIN.exists() else None
        old_enabled = systemctl('system', 'is-enabled', 'server-night-sleep.timer').stdout.strip() == 'enabled'
        try:
            for key, selected in config['services'].items():
                if not selected:
                    continue
                scope, unit = UNIT.fullmatch(key).groups()
                result = systemctl(scope, 'show', unit, '--property=LoadState', '--value')
                if result.returncode or result.stdout.strip() not in ('loaded', 'masked'):
                    raise ValueError('Unknown service: ' + key)
            atomic_write(CONFIG, json.dumps(config, indent=2) + '\n')
            atomic_write(DROPIN, f'[Timer]\nOnCalendar=\nOnCalendar=*-*-* {config["sleepTime"]}:00\n')
            run(['/usr/bin/systemctl', 'daemon-reload'])
            run(['/usr/bin/systemctl', 'enable' if config['enabled'] else 'disable', 'server-night-sleep.timer'])
            run(['/usr/bin/systemctl', 'restart' if config['enabled'] else 'stop', 'server-night-sleep.timer'])
        except Exception:
            if previous is not None:
                atomic_write(CONFIG, previous)
            elif CONFIG.exists():
                CONFIG.unlink()
            if old_dropin is not None:
                atomic_write(DROPIN, old_dropin)
            elif DROPIN.exists():
                DROPIN.unlink()
            run(['/usr/bin/systemctl', 'daemon-reload'], check=False)
            run(['/usr/bin/systemctl', 'enable' if old_enabled else 'disable', 'server-night-sleep.timer'], check=False)
            run(['/usr/bin/systemctl', 'restart' if old_enabled else 'stop', 'server-night-sleep.timer'], check=False)
            raise
    return config

def main():
    if len(sys.argv) < 2:
        raise ValueError('Missing operation')
    command = sys.argv[1]
    if command == 'apply' and len(sys.argv) == 2:
        raw = sys.stdin.read(32769)
        if len(raw) > 32768:
            raise ValueError('Settings too large')
        print(json.dumps(apply(validate(json.loads(raw)))))
    elif command == 'validate' and len(sys.argv) == 2:
        print(json.dumps(validate(json.load(sys.stdin))))
    elif command == 'check-services' and len(sys.argv) == 2:
        blockers = service_blockers(read_config())
        for reason in blockers:
            print(reason)
        return 1 if blockers else 0
    elif command == 'wake-time' and len(sys.argv) == 2:
        print(read_config()['wakeTime'])
    elif command == 'flag' and len(sys.argv) == 3 and sys.argv[2] in ('blockSsh', 'blockTmux'):
        return 0 if read_config()[sys.argv[2]] else 1
    else:
        raise ValueError('Unsupported operation')
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        # An unreadable policy must not silently permit suspend.
        sys.exit(2)
EOF
chown root:root /usr/local/sbin/homebase-power
chmod 755 /usr/local/sbin/homebase-power
```

### 3.3 `/usr/local/sbin/server-smart-sleep`

```bash
tee /usr/local/sbin/server-smart-sleep >/dev/null <<'EOF'
#!/usr/bin/env bash

set -u

USER_NAME="youruser"          # CHANGE ME
HOME_DIR="/home/youruser"     # CHANGE ME
STATE_DIR="$HOME_DIR/.local/state/server"
OVERRIDE="$STATE_DIR/stay-awake-tonight"

busy=0
reasons=()

mark_busy() {
    busy=1
    reasons+=("$1")
}

echo "=== SMART SLEEP CHECK ==="
echo "Time: $(date)"
echo

# HOMEBASE POWER INTEGRATION
POWER=/usr/local/sbin/homebase-power
if service_reasons="$("$POWER" check-services 2>&1)"; then
    :
else
    mark_busy "$service_reasons"
fi
# A configuration read error keeps the original conservative blocker enabled.
power_blocks() {
    local code=0
    "$POWER" flag "$1" || code=$?
    [ "$code" -ne 1 ]
}

if [ -e "$OVERRIDE" ]; then
    mark_busy "Manual stay-awake override is set"
fi

blockers="$(
    systemd-inhibit \
        --list \
        --what=sleep \
        --mode=block \
        --no-legend \
        --no-pager 2>/dev/null || true
)"

if [ -n "$blockers" ]; then
    mark_busy "A blocking systemd sleep inhibitor exists"
    echo "--- Blocking inhibitors ---"
    echo "$blockers"
    echo
fi

transfer_found=0

for proc in rsync rclone scp sftp borg restic; do
    if pgrep -x "$proc" >/dev/null 2>&1; then
        if [ "$transfer_found" -eq 0 ]; then
            echo "--- Active transfer/backup processes ---"
            transfer_found=1
        fi

        pgrep -af "$proc" || true
        mark_busy "Transfer/backup process active: $proc"
    fi
done

if [ "$transfer_found" -eq 1 ]; then
    echo
fi

gpu_jobs="$(
    nvidia-smi \
        --query-compute-apps=pid,process_name,used_memory \
        --format=csv,noheader 2>/dev/null |
    sed '/^[[:space:]]*$/d'
)"

if [ -n "$gpu_jobs" ]; then
    echo "--- Active NVIDIA compute jobs ---"
    echo "$gpu_jobs"
    echo
    mark_busy "NVIDIA/CUDA compute job active"
fi

tmux_cmds="$(
    sudo -u "$USER_NAME" \
        tmux list-panes -a \
        -F '#{session_name}|#{window_index}|#{pane_index}|#{pane_current_command}' \
        2>/dev/null || true
)"

if power_blocks blockTmux && [ -n "$tmux_cmds" ]; then
    tmux_busy=0

    while IFS='|' read -r session window pane command; do
        case "$command" in
            bash|zsh|sh|fish|"")
                ;;
            *)
                if [ "$tmux_busy" -eq 0 ]; then
                    echo "--- Busy tmux panes ---"
                    tmux_busy=1
                fi

                echo "$session:$window.$pane -> $command"
                mark_busy "Non-shell process running inside tmux"
                ;;
        esac
    done <<< "$tmux_cmds"

    if [ "$tmux_busy" -eq 1 ]; then
        echo
    fi
fi

ssh_sessions="$(
    ss -Htn state established '( sport = :22 )' 2>/dev/null || true
)"

if power_blocks blockSsh && [ -n "$ssh_sessions" ]; then
    ssh_count="$(printf '%s\n' "$ssh_sessions" | grep -c . || true)"

    echo "--- Active SSH connections ---"
    echo "$ssh_sessions"
    echo
    mark_busy "$ssh_count active SSH connection(s)"
fi

if command -v docker >/dev/null 2>&1; then
    docker_stats="$(
        docker stats \
            --no-stream \
            --format '{{.CPUPerc}}|{{.Name}}' \
            2>/dev/null || true
    )"

    docker_busy=0

    while IFS='|' read -r percent name; do
        [ -n "$percent" ] || continue

        value="${percent%\%}"

        if awk -v x="$value" 'BEGIN { exit !(x >= 10.0) }'; then
            if [ "$docker_busy" -eq 0 ]; then
                echo "--- Busy Docker containers (>=10% CPU) ---"
                docker_busy=1
            fi

            echo "$name -> $percent"
            mark_busy "Docker container using >=10% CPU"
        fi
    done <<< "$docker_stats"

    if [ "$docker_busy" -eq 1 ]; then
        echo
    fi
fi

read_cpu() {
    read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat

    total=$((user + nice + system + idle + iowait + irq + softirq + steal))
    idle_total=$((idle + iowait))

    echo "$total $idle_total"
}

DEFAULT_IFACE="$(
    ip route show default 2>/dev/null |
    awk 'NR==1 {print $5}'
)"

read -r cpu_total_1 cpu_idle_1 <<< "$(read_cpu)"

if [ -n "$DEFAULT_IFACE" ] &&
   [ -r "/sys/class/net/$DEFAULT_IFACE/statistics/rx_bytes" ]; then

    rx1="$(cat "/sys/class/net/$DEFAULT_IFACE/statistics/rx_bytes")"
    tx1="$(cat "/sys/class/net/$DEFAULT_IFACE/statistics/tx_bytes")"
else
    rx1=0
    tx1=0
fi

sleep 5

read -r cpu_total_2 cpu_idle_2 <<< "$(read_cpu)"

cpu_delta=$((cpu_total_2 - cpu_total_1))
idle_delta=$((cpu_idle_2 - cpu_idle_1))

if [ "$cpu_delta" -gt 0 ]; then
    cpu_busy="$(
        awk -v total="$cpu_delta" -v idle="$idle_delta" \
            'BEGIN { printf "%.1f", 100 * (total-idle) / total }'
    )"
else
    cpu_busy="0.0"
fi

echo "CPU busy over 5 sec: ${cpu_busy}%"

if awk -v x="$cpu_busy" 'BEGIN { exit !(x >= 15.0) }'; then
    mark_busy "System CPU usage >=15%"
fi

if [ -n "$DEFAULT_IFACE" ] &&
   [ -r "/sys/class/net/$DEFAULT_IFACE/statistics/rx_bytes" ]; then

    rx2="$(cat "/sys/class/net/$DEFAULT_IFACE/statistics/rx_bytes")"
    tx2="$(cat "/sys/class/net/$DEFAULT_IFACE/statistics/tx_bytes")"

    network_mib="$(
        awk \
            -v bytes="$(( (rx2-rx1) + (tx2-tx1) ))" \
            'BEGIN { printf "%.2f", bytes / 5 / 1024 / 1024 }'
    )"

    echo "Network ($DEFAULT_IFACE): ${network_mib} MiB/s"

    if awk -v x="$network_mib" 'BEGIN { exit !(x >= 1.0) }'; then
        mark_busy "Network traffic >=1 MiB/s"
    fi
fi

echo

if [ "$busy" -eq 0 ]; then
    echo "RESULT: SAFE TO SLEEP"
    exit 0
fi

echo "RESULT: BUSY - DO NOT SLEEP"
echo

printf ' - %s\n' "${reasons[@]}"

exit 1
EOF
chmod 755 /usr/local/sbin/server-smart-sleep
```

### 3.4 `/usr/local/sbin/server-night-sleep`

```bash
tee /usr/local/sbin/server-night-sleep >/dev/null <<'EOF'
#!/usr/bin/env bash

set -Eeuo pipefail

CHECK="/usr/local/sbin/server-smart-sleep"

log() {
    echo "$*"
    logger -t server-night-sleep "$*"
}

restore_server_policy() {
    log "Restoring server sleep masks"

    systemctl mask sleep.target suspend.target >/dev/null 2>&1 || true
    rtcwake -m disable >/dev/null 2>&1 || true
}

next_5am_epoch() {
    now="$(date +%s)"
    wake="$(date -d "today ${WAKE_TIME}:00" +%s)"

    if [ "$wake" -le "$now" ]; then
        wake="$(date -d "tomorrow ${WAKE_TIME}:00" +%s)"
    fi

    echo "$wake"
}

echo "=== NIGHT SLEEP CONTROLLER ==="
echo "Time: $(date)"
echo

if ! "$CHECK"; then
    log "Server is busy. Skipping nightly suspend."
    exit 0
fi

# HOMEBASE POWER INTEGRATION
WAKE_TIME="$(/usr/local/sbin/homebase-power wake-time)"
WAKE_EPOCH="$(next_5am_epoch)"
WAKE_HUMAN="$(date -d "@$WAKE_EPOCH" '+%Y-%m-%d %H:%M:%S %Z')"

echo
echo "Smart check passed."
echo "Planned wake: $WAKE_HUMAN"

if [ "${1:-}" = "--dry-run" ]; then
    echo
    echo "DRY RUN ONLY"
    echo "Would program RTC alarm for: $WAKE_HUMAN"
    echo "Would temporarily unmask:"
    echo "  sleep.target"
    echo "  suspend.target"
    echo "Would then suspend."
    echo "Would restore masks immediately after resume."
    exit 0
fi

trap restore_server_policy EXIT HUP INT TERM

log "Programming RTC wake for $WAKE_HUMAN"

rtcwake \
    -m no \
    -t "$WAKE_EPOCH"

log "Temporarily allowing suspend"

systemctl unmask sleep.target suspend.target

sync

log "Suspending server"

# Wait for the target's full suspend/resume transaction. The `suspend`
# convenience command is asynchronous and would let the EXIT trap restore the
# masks before logind starts suspend.target.
systemctl start --wait suspend.target

log "Server resumed"
EOF
chmod 755 /usr/local/sbin/server-night-sleep
```

> **Gotcha:** use `systemctl start --wait suspend.target`, not
> `systemctl suspend`. The latter returns right away, so the EXIT trap
> re-masks the target before logind acts on it and the suspend never happens.

### 3.5 `/usr/local/sbin/server-suspend-test` (manual test)

```bash
tee /usr/local/sbin/server-suspend-test >/dev/null <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

cleanup() {
    systemctl mask sleep.target suspend.target >/dev/null 2>&1 || true
    rtcwake -u -m disable >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

WAKE="$(date -d '+2 minutes' +%s)"

echo "Wake scheduled: $(date -d "@$WAKE")"

rtcwake -u -m no -t "$WAKE"

systemctl unmask sleep.target suspend.target

sync
sleep 5

# `systemctl suspend` only queues a request through logind and returns
# immediately. That races with the EXIT trap, which can re-mask the target
# before logind starts it. Starting the target with --wait keeps this process
# blocked until the suspend/resume transaction has completed.
systemctl start --wait suspend.target

echo "Successfully resumed at $(date)"
EOF
chmod 755 /usr/local/sbin/server-suspend-test
```

### 3.6 systemd units

```bash
tee /etc/systemd/system/server-night-sleep.service >/dev/null <<'EOF'
[Unit]
Description=Smart nightly server suspend

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/server-night-sleep
EOF

tee /etc/systemd/system/server-night-sleep.timer >/dev/null <<'EOF'
[Unit]
Description=Try smart server suspend at 00:30

[Timer]
OnCalendar=*-*-* 00:30:00
AccuracySec=1min
Persistent=false
Unit=server-night-sleep.service

[Install]
WantedBy=timers.target
EOF

mkdir -p /etc/systemd/system/server-night-sleep.timer.d
tee /etc/systemd/system/server-night-sleep.timer.d/homebase.conf >/dev/null <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 00:30:00
EOF
```

`Persistent=false` matters. If the server was off at 00:30, it must **not**
suspend as soon as it boots.

### 3.7 Mask sleep targets (server mode)

```bash
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

### 3.8 Enable

```bash
systemctl daemon-reload
systemctl enable --now server-night-sleep.timer
```

### 3.9 (Optional) Homebase dashboard sudo rule

Only needed if the Homebase web dashboard (`server-manager` repo) runs on that
server and should be able to change the schedule:

```bash
tee /etc/sudoers.d/homebase-power >/dev/null <<'EOF'
# Only validated sleep-policy updates; no shell or general systemctl access.
youruser ALL=(root) NOPASSWD: /usr/local/sbin/homebase-power apply
EOF
chmod 440 /etc/sudoers.d/homebase-power
visudo -cf /etc/sudoers.d/homebase-power
```

(Change `youruser` to the target user.) The repo also ships
`server/power/install.py`, but it **patches existing** pre-Homebase scripts in
place. On a fresh server, use the full scripts above instead.

---

## 4. Verify

```bash
systemctl list-timers server-night-sleep.timer      # next run shows the sleep time
systemctl is-enabled sleep.target suspend.target    # both: masked
/usr/local/sbin/homebase-power wake-time            # 05:00
sudo /usr/local/sbin/server-smart-sleep             # prints SAFE TO SLEEP or busy reasons
sudo /usr/local/sbin/server-night-sleep --dry-run   # full path, no suspend
```

Real hardware test (suspends now, wakes in ~2 min):

```bash
sudo /usr/local/sbin/server-suspend-test
systemctl is-enabled suspend.target                 # back to: masked
```

After the first night:

```bash
journalctl -t server-night-sleep --since yesterday
```

You should see `Programming RTC wake` → `Suspending server` →
`Server resumed` → `Restoring server sleep masks`.

---

## 5. Day-to-day operation

| Task | Command |
|------|---------|
| Skip tonight | `mkdir -p ~/.local/state/server && touch ~/.local/state/server/stay-awake-tonight` (as the configured user) |
| Re-allow | `rm ~/.local/state/server/stay-awake-tonight` |
| Change times/toggles | Edit JSON, then `sudo /usr/local/sbin/homebase-power apply < /etc/homebase/power.json` (rewrites the timer drop-in and restarts the timer) |
| Disable entirely | Set `"enabled": false` and apply, or `sudo systemctl disable --now server-night-sleep.timer` |
| Block on a service | Add `"system:foo.service": true` to `services`, then apply |
| Logs | `journalctl -t server-night-sleep` / `journalctl -u server-night-sleep.service` |

---

## 6. Troubleshooting

- **Doesn't wake:** check `cat /sys/class/rtc/rtc0/wakealarm` right after it
  is armed; check BIOS RTC wake; try `deep` instead of `s2idle`
  (`mem_sleep_default=deep` kernel parameter).
- **Wakes at the wrong hour:** the RTC is in local time, not UTC. Fix with
  `timedatectl set-local-rtc 0`.
- **Never suspends:** run `sudo server-smart-sleep` at the same time of night
  to see which blocker trips. Docker containers and network traffic are the
  usual culprits.
- **Suspend left unmasked after a crash:** `sudo systemctl mask sleep.target suspend.target`.
- **NVIDIA box doesn't resume cleanly:** enable `nvidia-suspend.service` and
  `nvidia-resume.service`.
