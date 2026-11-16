# Disk Usage Explorer: design notes and suggested improvements

Status: proposal (not implemented). Reviewed by a second agent (Codex); its points are merged in. Scope: the planned Storage feature that (1) shows which folders and files use the most space as an interactive treemap and (2) gives enough information to decide whether something can be deleted.

Today `server/disks.mjs` covers drives (lsblk, SMART, I/O) and `server/index.mjs` reports one `statfs('/')`. Nothing walks the filesystem yet, so the design below is written from scratch to fit the existing patterns: background refresh, no shell, root only through `homebase-power`, actions validated against inventory.

---

## 1. Core idea: change the question

The two original requirements ("show big things", "show info to decide") answer "what is big?". The question you actually care about is **"what can I safely get back, and how much?"** That leads to three changes:

1. **Reclaimable bytes, not just size.** A 40 GB folder of hardlinked backups, a btrfs snapshot or a file still held open by a process frees nothing (or much less) when deleted. Show *size* and *would free* side by side.
2. **Classify before you show.** Most large items on a server fall into known categories (Docker images, package caches, logs, model weights, build outputs, backups, media). A category tells you more than a timestamp does.
3. **Suggestions, not just a map.** The treemap is for exploring. Next to it, show a ranked "Cleanup candidates" list that already holds the decision info.

---

## 2. Scanning logic

### 2.1 What to scan
- Scan **per mounted filesystem**, starting from its mountpoint. Never cross into another filesystem (compare `st_dev`); show nested mounts as separate, non-expanding tiles labelled "mount: /mnt/x" with a link to scan them.
- Skip pseudo filesystems by fstype: `proc, sysfs, devtmpfs, tmpfs, cgroup2, overlay, squashfs, fuse.*` (configurable). `/snap` loop mounts and Docker's `overlay` mounts should not be counted twice.
- Default roots: `/` and each data mount from `readDisks().items[].volumes[].mounts`. Reuse that inventory, don't re-run lsblk. Also allow **configured roots** in `config.json`: the `PHYSICAL` filter in `server/disks.mjs` skips LVM-only, mdraid, NFS and other layouts.
- **Bind mounts on the same device bypass the `st_dev` check** and get walked twice. Read `/proc/self/mountinfo` and skip any directory that is a mountpoint other than the scan root.
- **Keep scanning out of `collectSnapshot()`** (`server/index.mjs:74`). Scans are separate background jobs with their own endpoints. Don't reuse the buffered 6-second `run()` helper (`server/index.mjs:26`) for `du`. Use `spawn` and stream the output.

### 2.2 How to measure
| Field | Source | Why |
|---|---|---|
| `size` (apparent) | `st_size` | What users expect to see |
| `disk` (allocated) | `st_blocks * 512` | What is actually used; differs for sparse files (VM images, databases) and compression |
| `reclaim` | `disk` counted only once per `(st_dev, st_ino)` and only when `st_nlink` links are all inside the selection | What deleting would actually free |

- **Rank and size the treemap by `disk`**, not `size`. Show both in the detail panel when they differ by more than 10 %.
- **`reclaim` is an estimate, never a promise.** Btrfs/ZFS snapshots, reflinks, compression and shared extents mean even allocated bytes can overstate what a delete frees. Label it "≈ up to X" and show a note on CoW filesystems (fstype from lsblk). Keep filesystem capacity (statfs) and treemap totals as separate numbers.
- Call `lstat` with `{bigint: true}` so dev/ino stay exact. On btrfs/XFS, inode numbers can exceed 2^53.
- **Hardlinks:** keep a `Set` of `dev:ino` for files with `nlink > 1`. Count the first sighting toward the tree and flag the others as `hardlink` (0 bytes reclaim unless every link is deleted).
- **Symlinks:** `lstat`, never follow. Show them as 0-byte leaves with their target in the details.

### 2.3 Engine
Options, in order of preference:
1. **Node walker in a separate child process** (`server/usage-scan.mjs`, started under `ionice -c3 nice -n19`) using `fs.opendir` plus `lstat({bigint:true})`, with 16 directories in flight. *Implemented.* A child process is used rather than a `worker_thread`: it gets real idle CPU and I/O priority, its memory (~380 MB for 1.2 M files) goes back to the system when it exits, and cancelling is a clean kill. Progress arrives over IPC, and the child writes the gzip cache itself.
2. **`du -x --block-size=1 --all -0`** via `spawn` (fast, battle-tested), parsed as a NUL-delimited stream. You lose mtime/owner data, so it's only good as a fallback.
3. **`gdu`/`ncdu -o` export**, if installed. Very fast on SSDs, but it adds an optional dependency.

Bound the concurrency with a work queue. Don't recurse with `Promise.all()`, which opens unbounded directory handles and floods the libuv threadpool, slowing every other request. For the `du` fallback, use `-0`/`--null` so file names that contain newlines parse correctly.

**Partial results are first-class.** Record `EACCES`/`EPERM`, entries that vanish mid-scan and subtrees that were cut off, on the node itself (`err`, `partial: true`). Never report them as 0 bytes. Cancelling must stop scheduling, close directory handles, kill child processes, and keep the result marked partial.

Scan as the dashboard user by default. Directories you can't read become a tile `🔒 unreadable (n dirs)` with a note: "Run with root helper for a full scan". A full scan would be a new read-only `homebase-power du <mount>` subcommand that returns the same JSON. Keep it read-only so it is no more privileged than `smart`.

### 2.4 Memory and size of results
A home server easily has 2–5 million inodes, and you can't ship that to the browser.
- Build the full tree in the worker but **keep only aggregates** for directories. Keep individual file nodes only if `disk ≥ max(1 MiB, 0.01 % of the scan root)`.
- Per directory, keep at most the **top N = 200 children by size**. Fold the rest into a synthetic `(n smaller items)` node.
- Lazy-load deeper levels: `GET /api/storage/tree?path=/var&depth=2` returns two levels below `path`. The treemap drills down by fetching.

### 2.5 Freshness and cost
- A scan is expensive (disk I/O, it spins up HDDs, it fills the page cache). **Never scan on a timer by default.** Scan on request, then cache the result in `~/.local/state/homebase/storage/<mount-id>.json.gz` with `scannedAt` and `durationMs`.
- Show "Scanned 3 h ago · 41 s · 1.2 M files" and a **Rescan** button. Optionally schedule a nightly scan at low priority (`nice 19` / `ionice -c3`) **before** the 00:30 suspend window, never during sleep.
- Respect HDD standby: if the target disk's SMART state is `standby` (already known from `disks.mjs`), ask before waking it.
- After a delete, subtract the freed bytes from the cached node and **all its ancestors**, and mark them "adjusted". A directory's mtime does not change when files deeper inside it change, so a cached tree slowly drifts and needs a periodic full rescan.
- **Delta view:** keep the previous scan and show *growth since last scan* per directory (`+3.4 GB`). This is often the most useful signal: "what filled my disk this week?".

### 2.6 Progress and cancel
Stream progress (files, bytes, current path) every 500 ms over the existing status polling or an SSE endpoint. Cancel calls `worker.terminate()`. Allow only one scan per filesystem at a time.

---

## 3. Information to decide on deletion

### 3.1 Per item (detail panel)
| Group | Fields |
|---|---|
| Size | allocated, apparent, % of parent, % of filesystem, file count, **reclaimable**, growth since last scan |
| Time | **mtime** (content changed), **ctime** (metadata changed), newest mtime *inside* a folder, oldest mtime. Show atime only with a warning, see below |
| Ownership | owner user/group, mode, whether the dashboard user can delete it (`access(parent, W_OK)` plus the sticky bit) |
| Usage | **open by a process?** (`/proc/*/fd` symlinks → pid + name), part of a running container or service? |
| Origin | category (see 3.2), **owned by a package?** (`dpkg -S`, cached and lazy, only on the detail view), git repo? (has `.git` → show `git status` dirty or clean) |
| Content | top 5 extensions by bytes (e.g. `.mp4 62 %`, `.gguf 30 %`), duplicate hint (same size plus a hash of the first and last 64 KiB) |

**Folders: use the newest mtime inside, not the folder's own mtime.** A directory's mtime only changes when entries are added or removed, so a folder whose files were edited yesterday can still look two years old. Compute `newestMtime` during the scan for free.

**ctime is not creation time.** It is the time of the last metadata change (chmod, rename, link). Label it that way. Use `statx` birth time only where the filesystem and Node expose it.

**atime is unreliable.** Most mounts use `relatime` or `noatime`, so "last accessed" is often wrong. Show atime only when the mount options (from `/proc/self/mountinfo`) are `strictatime`. Otherwise label it "≈ last read (relatime)" or hide it.

### 3.2 Category rules (built in, extendable in config)
| Category | Match | Default verdict | Better action than `rm` |
|---|---|---|---|
| Package cache | `/var/cache/apt/archives`, `~/.cache/pip`, `~/.npm/_cacache`, `~/.cache/yarn` | Safe | `apt clean`, `npm cache clean` |
| Docker | `/var/lib/docker/**` | **Never rm** | `docker system df` → `docker image/builder prune` |
| Journals | `/var/log/journal` | Safe to shrink | `journalctl --vacuum-size=500M` |
| Rotated logs | `*.log.[0-9]*`, `*.gz` under `/var/log` | Safe | delete |
| Snap | `/var/lib/snapd/snaps/*_N.snap` (disabled revisions) | Safe | `snap remove --revision` |
| Build output | `node_modules`, `target/`, `dist/`, `.venv`, `__pycache__` | Safe if repo is clean | delete, regenerable |
| AI models | `~/.ollama/models`, `*.gguf`, `~/.cache/huggingface` | Review | `ollama rm <model>` (blobs are shared between models) |
| Trash | `~/.local/share/Trash` | Safe | empty trash |
| Core dumps | `/var/lib/systemd/coredump`, `core.*` | Safe | delete |
| VM/disk images | `*.qcow2, *.img, *.iso, *.vmdk` | Review | — |
| Backups/archives | `*.tar*, *.zip, *.bak, *.dump` | Review | — |
| System / packages | owned by dpkg, `/usr`, `/boot`, `/etc`, `/var/lib/dpkg` | **Protected** | — |

The "better action" column is important: for Docker, Ollama, journald and apt, deleting the files directly corrupts the tool's state. The dashboard should **offer the tool's own command** (validated, no shell, like `server/actions.mjs` does now).

### 3.3 "Cleanup candidates" score
Call it **review priority**, not a safety score. Age and size never prove something is safe to delete. Rank by expected value, and penalize databases (`*.db`, `*.sqlite`, `/var/lib/mysql|postgresql`), credentials (`.ssh`, `.gnupg`, `*.pem`), unknown owners and protected locations:

```
score = reclaimBytes
      × ageFactor        // newestMtime: <7 d → 0.1, <30 d → 0.4, <180 d → 0.8, older → 1.0
      × categoryFactor   // safe 1.0, review 0.5, protected 0
      × (inUse ? 0 : 1)  // open by a process or a running container
```

For each candidate, show a one-line **reason**: "*2.3 GB · apt package cache · regenerable · untouched 94 days*". Users decide much faster when they read a reason than when they compare columns.

---

## 4. Treemap UX

- **Layout:** squarified treemap (d3-hierarchy `treemap().tile(treemapSquarify)`, about 6 KB, or a ~100-line hand-written squarify to keep the bundle lean). Show 2 levels at a time with a breadcrumb (`/ › var › lib › docker`). Click to drill down, Backspace or the breadcrumb to go up.
- **Area = allocated bytes. Colour = one chosen dimension**, toggled by the user:
  - *Category* (default, categorical palette)
  - *Age* (newest mtime, sequential: recent dark, old light, so stale data stands out)
  - *Growth* since last scan (diverging)
  Don't use colour for size, the area already shows it.
- **Labels** only on tiles larger than about 60×24 px. Tooltip on hover: name, size, % of parent, age, category.
- **Small slivers:** fold anything under 0.5 % of the view into `(n smaller items)` so the map stays readable.
- **Selection model:** click selects and opens the detail panel, double-click drills down. Allow multi-select (Ctrl-click) to build a "to delete" basket that shows a running *reclaimable* total.
- **Mobile** (the dashboard is used over Tailscale): fall back to a sorted bar list with the same drill-down. Treemaps are hard to tap on small screens.
- **Accessibility:** the same data as a sortable table (`components/ui/table.tsx`) behind a "Table" toggle, which also helps keyboard users.

---

## 5. Deletion logic (the risky part)

1. **Two-step, server-validated, by server-issued ID.** The client sends an **entry ID from the scan** (e.g. `scanGen:nodeIndex`), never a raw path. The server maps it to the `{path, dev, ino, mtimeNs, size}` it recorded, `lstat`s again just before acting, and **refuses if anything changed**. This narrows the race between check and delete (TOCTOU) and stops actions on stale scans, but it can't close that race completely. Node path APIs have no `openat2(RESOLVE_NO_SYMLINKS)`/`unlinkat` confinement, and nothing can atomically compare and unlink a name that is swapped concurrently. Removing that last gap would need a small unprivileged native helper that walks fd-relative. Treat it as optional hardening for later, and say so in the code.
2. **Path rules on the server, never trust the client:**
   - `realpath` must equal the path (no symlink components) and lie inside an allowed root.
   - Hard denylist: `/`, `/bin /boot /dev /etc /lib* /proc /run /sbin /sys /usr`, `/var/lib/{dpkg,apt,docker,containerd,snapd}`, the Homebase install directory, its config and state, every mountpoint itself, and `$HOME` itself (its children are allowed).
   - Refuse files owned by dpkg and files currently open (`/proc/*/fd`), or show a hard warning and require typing the name.
3. **Move to trash by default.** Use `~/.local/share/Trash` (freedesktop spec, with a `.trashinfo` file) when it's on the same filesystem. Otherwise use a per-mount `.homebase-trash/` with restore metadata. **Trash frees nothing until it's emptied.** Say so in the confirm dialog ("Moves 12 GB to trash · frees space when emptied"). Show trash size in the UI, auto-empty after N days (configurable, default 7), plus **Restore** and **Empty now**. A hard delete is a separate, explicit choice.
4. **Confirm with password above a threshold** (e.g. > 1 GB or > 1000 files), reusing the password confirmation added for Restart/Power off in 1.9.0.
5. **Keep the existing gate.** Scan and delete POSTs go through the same `access.mjs` peer checks and the token/JSON guards at `server/index.mjs:125`. Escape file names everywhere they are rendered (names are attacker-controlled data), and rate-limit and size-cap delete requests.
6. **Run as the dashboard user.** Do not add a root delete to `homebase-power`. Root-owned junk should go through the category actions (apt clean, journald vacuum), which are fixed and safe. A generic root `rm` through the dashboard means a stolen session can wipe the server.
7. **Delete without blocking:** use `fs.rm(path, {recursive: true})` in the worker, report progress, and log to `record()` (events) with path and bytes freed.
8. **Verify the result:** after deletion, compare `statfs` before and after and report *actual* bytes freed. If it is much less than expected, explain why (snapshots, hardlinks, open files).

---

## 6. Extra features worth adding

- **"Deleted but still open" files.** Scan `/proc/*/fd` for links ending in `(deleted)` and show them as a virtual tile with the pid, process name and size. These are a classic cause of "df says full, du says not" (e.g. a rotated log still held by a daemon). Fix: restart the service, using the existing service actions.
- **df vs du gap.** Show `statfs used − scanned total` as an "Unaccounted" tile. Explain the usual causes: unreadable directories, open-deleted files, filesystem metadata, reserved blocks (5 % on ext4, see `tune2fs -m`), btrfs/ZFS snapshots.
- **Low-space alert.** Hook into `server/alerts.mjs`: warn at 85 % / 95 % full, and include the top 3 cleanup candidates in the alert text.
- **Fill forecast.** From daily `statfs` samples, estimate "full in ~23 days at the current rate".
- **Duplicates** (optional, run on request): group by size, then a partial hash, then a full hash, but only for files over 100 MB.

---

## 7. API sketch

```
GET  /api/storage/mounts                         → filesystems with statfs, last scan info
POST /api/storage/scan     {mount, root?:bool}   → starts scan (409 if running)
GET  /api/storage/scan?mount=…                   → progress {files, bytes, path, done}
DELETE /api/storage/scan?mount=…                 → cancel
GET  /api/storage/tree?mount=…&path=…&depth=2    → pruned subtree with aggregates
GET  /api/storage/item?path=…                    → detail (open-by, dpkg owner, git, extensions)
GET  /api/storage/candidates?mount=…             → ranked list with reasons
POST /api/storage/action   {kind:'trash'|'delete'|'restore'|'empty-trash'|'cleanup', target, id /*server-issued entry id*/, password?}
```

Node shape (keep it compact, the client builds labels):
```ts
type Node = {n: string; d: number /*alloc bytes*/; s?: number /*apparent*/; f?: number /*files*/;
  m: number /*newest mtime*/; c?: string /*category*/; k?: 'dir'|'file'|'link'|'mount'|'more'|'locked';
  g?: number /*growth*/; ch?: Node[]};
```

---

## 8. Tests to add (`tests/storage.test.mjs`)
- Hardlinked file counted once; reclaim is 0 when only one link is selected.
- Sparse file: `disk < size`, and ranking uses `disk`.
- Walk does not cross `st_dev`, and a symlink loop doesn't recurse.
- Unreadable directory becomes a `locked` node, and the scan still finishes.
- Same-device bind mount is not walked twice; file names with newlines survive the `du -0` parser.
- Cancelled scan is marked `partial`, and no handles are leaked.
- Pruning: more than 200 children produce a `more` node with correct totals.
- Delete guard: unknown/stale entry id → refused; changed mtime/ino → refused; symlinked parent → refused; denylisted path → refused.
- Category matcher table-driven tests.

---

## 9. Suggested build order
1. ✅ Scanner + cache + `tree` endpoint + read-only treemap (biggest value, no risk). Done: `server/usage-scan.mjs`, `server/usage.mjs`, `src/UsagePanel.tsx`, `tests/usage.test.mjs`. On this machine, `/` (1.44 M files) scans in 12 s, and a home-directory scan matched `du -sx` to the byte.
2. ✅ Detail panel (mtime/newest, open-by, category, dpkg owner). Done: `server/categories.mjs` (ordered rules, verdict safe / review / keep, active swap from `/proc/swaps`), `server/usage-item.mjs`, `GET /api/storage/item`, `src/UsageDetail.tsx`, and the treemap's "Category" colour mode. Click selects an item and double-click opens a folder. The scanner now also records the oldest file time per folder (`o`). Two choices differ from §3.1: git facts are read from `.git` files instead of running `git status`, because repository config such as `core.fsmonitor` or clean filters can execute commands and any folder may hold a hostile repo. The duplicate hint is left for §6.
3. ✅ Cleanup candidates + tool-native actions (apt, journald, docker prune, ollama rm). Done: `server/cleanup.mjs`, `GET /api/storage/cleanup`, `POST /api/storage {action:'cleanup'}`, `src/UsageCleanup.tsx` (the panel's "Cleanup" view), `tests/cleanup.test.mjs`.
   - **Tools:** APT cache, journal vacuum to 500M, disabled snap revisions, Docker build cache and unused images, pip, npm, trash, and per-model `ollama rm` through the Ollama API (only models the server just listed). Each is measured before it is offered.
   - **Root actions:** they go through the helper's new `cleanup apt|snaps|journal <200M|500M|1G>`, which takes no path. The new sudoers lines are only installed by re-running the administrator setup. Until then, the UI offers the command to copy.
   - **Candidates:** "category roots" (the topmost folder of a category), with sizes that exclude nested roots of another category, plus large folders untouched for months. A folder counts as stale only when nothing inside it is recognised. Protected trees are walked but not listed, so `miniforge3/pkgs` is found inside `miniforge3`. Candidates a measured tool covers are shown with that tool instead.
   - **New categories:** "Installed software" (keep: `~/.local/lib/python*`, `.nvm`, `.vscode-server`, conda installs…) and "Conda package cache" (safe).
4. ✅ Trash-based delete with guards + password threshold. Done: `server/delete.mjs`, the delete and trash parts of `server/usage.mjs`, `verifyOwnPassword` in `server/machine.mjs`, `src/DeleteDialog.tsx`, the Trash list in `src/UsageCleanup.tsx`, `tests/delete.test.mjs`.
   - **Two steps:** `delete-prepare` re-checks the item and returns a 5-minute, single-use id bound to its dev/inode/type (and mtime for files). `delete` checks everything again and refuses if the item changed. This narrows the race between check and delete rather than closing it, as §5.1 says.
   - **Blocked:**
     - a filesystem root;
     - your home folder or anything containing it;
     - mountpoints, and folders with something mounted inside;
     - Homebase's install, config and state folders, the trash itself, and anything containing them;
     - "keep" categories, paths owned by a dpkg package, and paths with a symlink anywhere in them;
     - files open in your processes, and paths the dashboard user cannot delete.
   - **Trash:** the freedesktop.org trash, the same one the desktop uses. That is `~/.local/share/Trash` on the home filesystem and `<mount>/.Trash-<uid>` elsewhere. The `.trashinfo` file is created exclusively first, then the item is renamed into the trash, so nothing is copied. Homebase records what it trashed in `~/.local/state/homebase/trash.json`. Restore and the auto-empty (`storage.trashDays`, default 7) only touch those entries, never the rest of the desktop trash.
   - **Password:** required for every permanent delete, and for moving to trash anything over 1 GB or 1,000 files. It is checked with `unix_chkpwd`, which is setgid shadow, so no root is needed. It shares the wrong-password lockout with Restart / Power off.
   - **After a delete:** the item is removed from the cached tree, its size is subtracted from every ancestor, and the scan is marked `adjusted`.
   - **Hardened after a Codex security review:**
     - The trash log is not trusted. Before restoring or purging, each entry must point to a known trash folder, use a single-component name, and match the device and inode recorded when it was trashed. Anything else is dropped from the log and left untouched.
     - Trash folders and their `files/` and `info/` subfolders must be real directories owned by the account, with no symlinks in their path.
     - Restore refuses if the original location's parent path is, or goes through, a symlink.
     - Emptying an item from the trash needs the password. Auto-empty does not.
     - "Big" is decided again at delete time with a bounded walk, because the scan may be old. Unreadable parts count as big.
     - Password checks are serialized, so parallel guesses cannot all get past the lockout at once.
     - A rename-without-replace race remains on restore (Node has no `RENAME_NOREPLACE`), as noted in the code.
5. ✅ Delta-since-last-scan, open-deleted files, alerts and forecast. Done: `annotateGrowth` in `server/usage-scan.mjs`, `growthHotspots` in `server/usage.mjs`, `server/space.mjs`, the Growth colour mode, banner and forecast in `src/UsagePanel.tsx`, the "Grew since the previous scan" and "Space the map can't see" sections in `src/UsageCleanup.tsx`, the Storage badge and toast in `app/page.tsx`, `tests/space.test.mjs`.
   - **Growth:** the scanner reads the cache it is about to replace and tags every node with `g` (growth in allocated bytes) or `nw` (new), in its own process, so the server never holds two trees. Hotspots break a folder's growth into the children that explain 60% or more of it, and report the folder itself when growth is spread out. Deletes made from the dashboard lower `g` along the path, so they do not show up as shrinkage.
   - **Hidden space:** at the end of a scan the scanner records the filesystem's own used figure (`meta.fsUsed`). Cleanup shows the gap and its likely causes: unreadable folders, deleted files still held open, and metadata or snapshots. Deleted-but-open files come from `/proc/*/fd` for the dashboard user's own processes, limited to that filesystem; memfd and tmpfs are excluded.
   - **Alerts and forecast:** `statfs` is sampled hourly in the background, one point per day is kept for 120 days (`~/.local/state/homebase/storage/space-history.json`), and a least-squares fit over the last 30 days gives bytes per day and days until full. The fit needs at least 4 points over 3 or more days. Levels: warn at 85% full or full within 14 days, critical at 95% or full within 3 days. A non-ok level adds a Storage nav badge, a toast when the level gets worse, and a banner naming the top 3 cleanup candidates. This lives next to, not inside, the security alerts in `server/alerts.mjs`, which belong to the Traffic page.

---

## 10. Resource use

All figures below are measured on this server (ext4 SSD, `/` with 1.44 M files and 119 k folders).

| | Before | After |
|---|---|---|
| Scanner peak RSS, repeat scan (also loads the previous tree for growth) | 604 MB | **280–290 MB** |
| Scanner CPU | 183–202% | ~110% (at nice 19, idle I/O class) |
| Scanner voluntary context switches | 2.4 M | ~4–9 k |
| Scan time | 10 s | 10.5 s |
| Listing filesystems (`GET /api/storage`, polled every 1.5 s while scanning) | 185–280 ms, +200 MB RSS | **2–10 ms**, no tree loaded |
| Cleanup suggestions, first call | 347 ms, whole tree loaded | **17–21 ms**, no tree loaded |
| Server RSS with nothing being browsed | up to 366 MB | **~60 MB** |

How:
- **Summary sidecar:** `<cache>.meta.json`, a few KB written by the scanner process (`server/usage-scan-run.mjs`). It holds the scan meta, the cleanup candidates and the growth hotspots. The filesystem list, the Cleanup view and the low-space banner read only this file. The ~70 MB tree is loaded only to browse the map, and dropped after 3 minutes without use. Deletes update the summary in place. Caches from before the sidecar existed get one built once.
- **Scanner** (`server/usage-scan.mjs`, optimised by Codex):
  - Synchronous fs calls inside the dedicated child, with a turn on the event loop every 32 folders, so progress and Stop still get through.
  - Wait/notify instead of 5 ms polling.
  - Plain-number `lstat`, with bigint identity only for hardlinks.
  - Streaming JSON + gzip for writing and reading the cache.
- **Node flags for the scanner:** `--max-semi-space-size=4`, plus `--max-old-space-size` scaled from the previous scan's file count (512 MB minimum, 4 GB maximum). If a scan still runs out of heap, it is retried once without the limit.
- **Lighter background work:** tool measurements (du, docker, snap, journalctl) are cached for 5 minutes, and the low-space banner skips the `/proc` walk.
