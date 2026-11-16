// What a path probably is, and how to get its space back. Rules match absolute paths and are checked in order,
// so the protective ones (credentials, databases, container storage, the OS) win over the cleanup ones.
// verdict: "safe" (regenerable or disposable), "review" (yours to judge), "keep" (deleting files directly breaks
// something; use the hint instead). A category only describes; it never makes anything deletable by itself.

const P = String.raw;
/** [id, label, verdict, path regex, hint] */
const RULES = [
  ['credentials', 'Keys and credentials', 'keep', P`/\.(ssh|gnupg|password-store)(/|$)|\.(pem|key|kdbx)$`, 'Keys and secrets. Never delete without a backup.'],
  ['database', 'Database files', 'keep', P`^/var/lib/(mysql|mariadb|postgresql|mongodb|redis|influxdb)(/|$)|\.(sqlite3?|db)$`, 'Live database data. Use the database’s own tools to shrink or drop data.'],
  ['containers', 'Docker / containers', 'keep', P`^/var/lib/(docker|containerd|containers)(/|$)|/\.local/share/containers(/|$)`, 'Managed by Docker. Run `docker system df`, then `docker image prune -a` or `docker builder prune`. Never delete these files directly.'],
  ['packages-db', 'Package manager state', 'keep', P`^/var/lib/(dpkg|apt|snapd/(state|seed))(/|$)`, 'The package database. Deleting it breaks apt or snap.'],
  ['snaps', 'Snap revisions', 'review', P`^/var/lib/snapd/snaps(/|$)`, 'Old revisions: `snap list --all`, then `sudo snap remove <name> --revision <n>` for disabled ones.'],
  ['models', 'AI models', 'review', P`/\.ollama/models(/|$)|/\.cache/huggingface(/|$)|/\.cache/lm-studio(/|$)|\.(gguf|safetensors|ckpt|onnx)$`, 'Model weights. For Ollama use `ollama rm <model>`: blobs are shared between models.'],
  ['system', 'Operating system', 'keep', P`^/(usr|bin|sbin|lib|lib32|lib64|libx32|boot|etc|efi)(/|$)`, 'Installed software and configuration. Remove packages with apt rather than deleting files.'],
  ['vcs', 'Git history', 'keep', P`/\.git(/|$)`, 'Repository history. Use `git gc` or `git lfs prune` to shrink it.'],
  ['conda-pkgs', 'Conda package cache', 'safe', P`/(miniforge3|miniconda3|anaconda3|mambaforge|\.conda)/pkgs(/|$)`, 'Downloaded conda packages: `conda clean --all`.'],
  ['user-software', 'Installed software', 'keep', P`/\.local/lib/python[\d.]+(/|$)|/\.(nvm|rustup|pyenv|TinyTeX|vscode|vscode-server|cursor-server|windsurf-server)(/|$)|/\.cargo/bin(/|$)|/(miniforge3|miniconda3|anaconda3|mambaforge)(/|$)|/\.local/share/(JetBrains|pnpm)(/|$)`, 'Software installed in your home folder. Uninstall it with its own tool (pip uninstall, nvm uninstall, the editor) rather than deleting files.'],
  ['apt-cache', 'APT package cache', 'safe', P`^/var/cache/apt(/|$)`, 'Downloaded .deb files: `sudo apt clean`.'],
  ['journal', 'System journal', 'safe', P`^/var/log/journal(/|$)`, 'Shrink with `sudo journalctl --vacuum-size=500M` instead of deleting files.'],
  ['old-logs', 'Rotated logs', 'safe', P`^/var/log/.*\.(\d+|gz|xz|bz2|zst|old)$`, 'Rotated log archives. Safe to delete.'],
  ['logs', 'Logs', 'review', P`^/var/log(/|$)|\.log$`, 'Active logs. Prefer logrotate. A deleted log still open by a process keeps its space.'],
  ['coredumps', 'Crash dumps', 'safe', P`^/var/(lib/systemd/coredump|crash)(/|$)|/core\.\d+$`, 'Crash dumps. Safe to delete unless you are debugging a crash.'],
  ['trash', 'Trash', 'safe', P`/\.local/share/Trash(/|$)|/\.Trash-\d+(/|$)`, 'Already deleted. Empty the trash.'],
  ['pkg-cache', 'Package caches', 'safe', P`/\.cache/(pip|yarn|pnpm|go-build|uv|bazel|composer)(/|$)|/\.npm/_cacache(/|$)|/\.cargo/registry/cache(/|$)|/\.gradle/caches(/|$)|/\.m2/repository(/|$)`, 'Download caches. Re-downloaded when needed (`npm cache clean --force`, `pip cache purge`, ...).'],
  ['build', 'Build output and dependencies', 'safe', P`/(node_modules|__pycache__|\.venv|venv|\.tox|\.next|\.nuxt|\.parcel-cache|\.turbo|\.pytest_cache|\.mypy_cache)(/|$)|/target/(debug|release)(/|$)`, 'Rebuilt by `npm install`, `pip install` or the build. Check that the project still builds.'],
  ['cache', 'Application cache', 'safe', P`/\.cache(/|$)|^/var/cache(/|$)`, 'Caches that applications rebuild. Close the app first.'],
  ['tmp', 'Temporary files', 'review', P`^/(var/)?tmp(/|$)`, 'Temporary files. Some may belong to running programs.'],
  ['disk-images', 'Disk and VM images', 'review', P`\.(qcow2|vmdk|vdi|vhdx?|iso|img|raw)$`, 'Disk images. Check that no VM uses them.'],
  ['archives', 'Backups and archives', 'review', P`/backups?(/|$)|\.(tar|tgz|tbz2|txz|zip|7z|rar|bak|dump|zst)$|\.tar\.\w+$|\.sql\.gz$`, 'Backups. Check that a newer copy exists elsewhere.'],
  ['media', 'Media', 'review', P`\.(mp4|mkv|avi|mov|webm|m4v|mp3|flac|wav|m4a|ogg|jpe?g|png|heic|raw|cr2|nef|arw)$`, 'Personal media.'],
].map(([id, label, verdict, re, hint]) => ({id, label, verdict, re: new RegExp(re, 'i'), hint}));

export const CATEGORIES = Object.fromEntries(RULES.map(({id, label, verdict, hint}) => [id, {label, verdict, hint}]));
export const SWAP = {id: 'swap', label: 'Swap file', verdict: 'keep', hint: 'Active swap. Turn it off (`sudo swapoff`) and remove it from /etc/fstab before deleting it.'};
CATEGORIES.swap = {label: SWAP.label, verdict: SWAP.verdict, hint: SWAP.hint};

/** Category id for an absolute path, or null. `swaps` is the set of active swap files from /proc/swaps. */
export function categorize(path, swaps = new Set()) {
  if (swaps.has(path)) return 'swap';
  for (const r of RULES) if (r.re.test(path)) return r.id;
  return null;
}

/** /proc/swaps → absolute paths of swap files (partitions are not files in any tree). */
export function parseSwaps(raw) {
  return new Set(raw.split('\n').slice(1).map(l => l.split(/\s+/)).filter(f => f[1] === 'file').map(f => f[0].replace(/\\040/g, ' ')));
}
