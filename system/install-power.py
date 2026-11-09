#!/usr/bin/python3 -I
"""Install (or remove) Homebase's optional root integration: nightly smart sleep and system-service control.

  sudo python3 system/install-power.py --user <account>     install or update
  python3 system/install-power.py --check --user <account>  validate everything, change nothing
  sudo python3 system/install-power.py --uninstall          remove what this installer added

What it installs (previous copies are backed up to /var/backups/homebase-power/<timestamp>/):
  /usr/local/sbin/homebase-power            fixed-purpose root helper (validated JSON, no shell)
  /usr/local/sbin/server-smart-sleep        "is the server busy?" check
  /usr/local/sbin/server-night-sleep        nightly controller: check, arm RTC wake, suspend
  /etc/systemd/system/server-night-sleep.{service,timer}
  /etc/sudoers.d/homebase-power             passwordless access to the helper for <account> only
  /etc/homebase/owner, /etc/homebase/power.json
Nothing ever suspends during installation. On a fresh machine nightly sleep starts disabled;
turn it on from Homebase → Sleep & power.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SBIN = pathlib.Path('/usr/local/sbin')
UNITS = pathlib.Path('/etc/systemd/system')
ETC = pathlib.Path('/etc/homebase')
SUDOERS = pathlib.Path('/etc/sudoers.d/homebase-power')
BACKUPS = pathlib.Path('/var/backups/homebase-power')
FILES = [  # (source in system/, destination, mode)
    ('homebase-power', SBIN / 'homebase-power', 0o755),
    ('server-smart-sleep', SBIN / 'server-smart-sleep', 0o755),
    ('server-night-sleep', SBIN / 'server-night-sleep', 0o755),
    ('server-night-sleep.service', UNITS / 'server-night-sleep.service', 0o644),
    ('server-night-sleep.timer', UNITS / 'server-night-sleep.timer', 0o644),
]
DISABLED = {'enabled': False, 'sleepTime': '00:30', 'wakeTime': '05:00', 'blockSsh': True, 'blockTmux': True, 'services': {}}
USERNAME = re.compile(r'[a-z_][a-z0-9_-]{0,31}\Z')


def sudoers_for(user):
    return (f'# Installed by Homebase. Validated sleep-policy updates and start/stop/restart of custom units in\n'
            f'# /etc/systemd/system, and read-only SMART health of whole disks, through a fixed-purpose helper;\n'
            f'# arguments are validated by the helper. No shell.\n'
            f'{user} ALL=(root) NOPASSWD: /usr/local/sbin/homebase-power apply\n'
            f'{user} ALL=(root) NOPASSWD: /usr/local/sbin/homebase-power service *\n'
            f'{user} ALL=(root) NOPASSWD: /usr/local/sbin/homebase-power smart *\n')


def run(*args, **kw):
    return subprocess.run(list(args), text=True, check=True, **kw)


def visudo_check(text, directory):
    """Validate sudoers text in a file sudo ignores (name contains a dot); returns its path."""
    fd, name = tempfile.mkstemp(prefix='.homebase-power.', dir=directory)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.chmod(name, 0o440)
    try:
        run('/usr/sbin/visudo', '-cqf', name, stdout=subprocess.DEVNULL)
    except Exception:
        os.unlink(name)
        raise
    return name


def preflight(user):
    problems = []
    for tool in ('/usr/bin/systemctl', '/usr/sbin/visudo', '/usr/sbin/runuser'):
        if not os.path.exists(tool):
            problems.append(f'missing {tool}')
    if not shutil.which('rtcwake'):
        problems.append('rtcwake not found (package util-linux); nightly wake would not be armed')
    for name in ('server-smart-sleep', 'server-night-sleep'):
        run('/usr/bin/bash', '-n', str(HERE / name))
    subprocess.run([sys.executable, '-I', '-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', str(HERE / 'homebase-power')], check=True)
    if not USERNAME.fullmatch(user):
        problems.append(f'invalid account name {user!r}')
    else:
        try:
            if pwd.getpwnam(user).pw_uid == 0:
                problems.append('the Homebase account must not be root')
        except KeyError:
            problems.append(f'no such account {user!r}')
    return problems


def install(user):
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = BACKUPS / stamp
    backup.mkdir(parents=True, mode=0o700)
    for path in [dst for _, dst, _ in FILES] + [SUDOERS, ETC / 'owner', ETC / 'power.json']:
        if path.exists():
            shutil.copy2(path, backup / path.name)
    # Validate sudoers before anything goes live; a broken file must never be installed.
    staged = visudo_check(sudoers_for(user), SUDOERS.parent)
    ETC.mkdir(mode=0o755, exist_ok=True)
    owner = ETC / 'owner'
    owner.write_text(user + '\n')
    owner.chmod(0o644)
    for source, dest, mode in FILES:
        data = (HERE / source).read_bytes()
        tmp = dest.with_name('.' + dest.name + '.homebase-new')
        tmp.write_bytes(data)
        os.chown(tmp, 0, 0)
        tmp.chmod(mode)
        os.replace(tmp, dest)
        if hashlib.sha256(dest.read_bytes()).digest() != hashlib.sha256(data).digest():
            raise SystemExit(f'Verification failed for {dest}')
    config = ETC / 'power.json'
    if not config.exists():
        config.write_text(json.dumps(DISABLED, indent=2) + '\n')
        config.chmod(0o644)
    run('/usr/bin/systemctl', 'daemon-reload')
    # Re-apply the stored policy so the timer drop-in and enable state match it (never suspends).
    run(str(SBIN / 'homebase-power'), 'apply', input=config.read_text(), stdout=subprocess.DEVNULL)
    os.replace(staged, SUDOERS)
    print(f'Homebase root integration installed for {user}.')
    print(f'Previous files backed up to {backup}.')
    print('Nightly sleep is ' + ('ENABLED' if json.loads(config.read_text())['enabled'] else 'disabled') + ' — change it in Homebase → Sleep & power.')


def uninstall():
    if (UNITS / 'server-night-sleep.timer').exists():
        subprocess.run(['/usr/bin/systemctl', 'disable', '--now', 'server-night-sleep.timer'], check=False)
    removed = []
    for path in [SUDOERS, SBIN / 'homebase-power', SBIN / 'server-smart-sleep', SBIN / 'server-night-sleep',
                 UNITS / 'server-night-sleep.service', UNITS / 'server-night-sleep.timer',
                 UNITS / 'server-night-sleep.timer.d' / 'homebase.conf', ETC / 'owner', ETC / 'power.json']:
        if path.exists():
            path.unlink()
            removed.append(str(path))
    for d in (UNITS / 'server-night-sleep.timer.d', ETC):
        if d.exists() and not any(d.iterdir()):
            d.rmdir()
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=False)
    print('Removed:\n  ' + '\n  '.join(removed) if removed else 'Nothing to remove.')
    print('Sleep targets were left as they are. Backups remain in', BACKUPS)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--user', default=os.environ.get('SUDO_USER'), help='account that runs Homebase (default: the sudo caller)')
    ap.add_argument('--check', action='store_true', help='validate only; change nothing')
    ap.add_argument('--uninstall', action='store_true', help='remove the root integration')
    args = ap.parse_args()
    if args.uninstall:
        if os.geteuid() != 0:
            sys.exit('Run with sudo.')
        return uninstall()
    if not args.user:
        sys.exit('Pass --user <account> (the account that runs Homebase).')
    problems = preflight(args.user)
    fatal = [p for p in problems if not p.startswith('rtcwake')]
    for p in problems:
        print(('ERROR: ' if p in fatal else 'warning: ') + p, file=sys.stderr)
    if fatal:
        sys.exit(1)
    if args.check:
        print(f'Check passed for {args.user}: scripts parse, helper compiles. No files changed.')
        return
    if os.geteuid() != 0:
        sys.exit('Run with sudo: sudo python3 ' + str(pathlib.Path(__file__).resolve()) + f' --user {args.user}')
    install(args.user)


if __name__ == '__main__':
    main()
