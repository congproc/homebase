// Cleanup candidates and growth hotspots from a usage tree. Pure functions with light imports, so the scanner
// process can compute them once per scan and the server never has to load a whole tree just to suggest cleanups.
import path from 'node:path';
import {CATEGORIES, categorize} from './categories.mjs';

const GB = 1024 ** 3, MB = 1024 ** 2, DAY = 86400000;

const CATEGORY_FACTOR = {safe: 1, review: 0.5, keep: 0};
/** Weight by how recently anything inside changed: fresh data is rarely what you want to delete. */
export const ageFactor = age => age < 7 * DAY ? 0.1 : age < 30 * DAY ? 0.4 : age < 180 * DAY ? 0.8 : 1;
const days = ms => Math.floor(ms / DAY);
/** "95 days", "7 months", "3 years": how long nothing changed, in words a person would use. */
const span = ms => { const d = days(ms); return d < 60 ? `${d} days` : d < 548 ? `${Math.round(d / 30.44)} months` : `${Math.round(d / 365.25)} years`; };
const STALE_DIR = {bytes: GB, age: 180 * DAY}, STALE_FILE = {bytes: 512 * MB, age: 90 * DAY}, MIN_ITEM = 50 * MB;

/** Which tool cleans a candidate, from its category and path. */
export function toolFor(cat, abs) {
  if (cat === 'apt-cache') return 'apt';
  if (cat === 'journal') return 'journal';
  if (cat === 'snaps') return 'snaps';
  if (cat === 'containers') return 'docker-images';
  if (cat === 'trash') return 'trash';
  if (cat === 'models' && abs.includes('/.ollama/')) return 'ollama';
  if (cat === 'pkg-cache' && /\/\.cache\/pip(\/|$)/.test(abs)) return 'pip';
  if (cat === 'pkg-cache' && /\/\.npm(\/|$)/.test(abs)) return 'npm';
  return null;
}

/**
 * Ranked things to review, from a cached tree. A "category root" is the topmost folder of a category (for example
 * ~/.cache, or one node_modules). Its size excludes nested roots of another category (~/.cache/huggingface is
 * counted as models, not twice as cache). Large uncategorised folders untouched for months are added as "stale".
 * Protected ("keep") categories are never listed, though safe categories nested inside them are.
 */
export function findCandidates(tree, mountPath, {now = Date.now(), swaps = new Set(), limit = 40} = {}) {
  const roots = [];
  // A stale folder is only flagged when no category was recognised inside it, so an old /home or /srv never hides
  // the specific caches and backups within it; it does absorb stale files and folders below it.
  let categorized = 0;
  const walk = (node, abs, current) => {
    if (!node.n) return; // synthetic "files"/"more" entries
    const before = categorized;
    // The filesystem root is never a candidate itself (it cannot be deleted): its contents are judged one by one.
    const cat = abs === mountPath ? null : categorize(abs, swaps);
    if (cat && cat !== current?.cat) {
      const root = {cat, abs, node, excl: node.d};
      if (current) current.excl -= node.d;
      roots.push(root); categorized++;
      // Protected roots are not listed, but are still walked: a safe part can sit inside one (miniforge3/pkgs).
      current = root;
    }
    for (const c of node.ch || []) walk(c, path.posix.join(abs, c.n), current);
    if (!cat && !current && categorized === before && abs !== mountPath) {
      const age = now - node.m;
      const stale = node.ch ? node.d >= STALE_DIR.bytes && age >= STALE_DIR.age : node.k === 'file' && node.d >= STALE_FILE.bytes && age >= STALE_FILE.age;
      if (stale) {
        for (let i = roots.length - 1; i >= 0 && roots[i].cat === 'stale' && roots[i].abs.startsWith(abs + '/'); i--) roots.pop();
        roots.push({cat: 'stale', abs, node, excl: node.d});
      }
    }
  };
  walk({...tree, n: tree.n || mountPath}, mountPath, null);

  const items = [], groups = new Map();
  for (const r of roots) {
    const meta = r.cat === 'stale' ? {label: 'Not touched in months', verdict: 'review', hint: 'Nothing inside has changed for a long time. Check whether you still need it, or archive it elsewhere.'} : CATEGORIES[r.cat];
    if (meta.verdict === 'keep' || r.excl < MIN_ITEM) continue;
    const age = now - r.node.m;
    const score = r.excl * ageFactor(age) * CATEGORY_FACTOR[meta.verdict];
    const g = groups.get(r.cat) || {category: r.cat, label: meta.label, verdict: meta.verdict, bytes: 0, count: 0};
    g.bytes += r.excl; g.count++; groups.set(r.cat, g);
    const reason = [`${meta.label}`, meta.verdict === 'safe' ? 'regenerable' : 'review first', r.node.m ? (age < DAY ? 'changed today' : age < 30 * DAY ? `changed ${days(age)} day${days(age) === 1 ? '' : 's'} ago` : `untouched ${span(age)}`) : null].filter(Boolean).join(' · ');
    items.push({path: r.abs, kind: r.node.k, category: r.cat, label: meta.label, verdict: meta.verdict, hint: meta.hint, bytes: r.excl, files: r.node.f, newest: r.node.m || null,
      score, reason, tool: toolFor(r.cat, r.abs)});
  }
  items.sort((a, b) => b.score - a.score);
  return {items: items.slice(0, limit), more: Math.max(0, items.length - limit), groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes)};
}

/**
 * Where the growth since the previous scan happened. A folder whose growth is mostly (60%+) explained by children
 * that each grew noticeably is broken down into those children; otherwise it is reported itself (growth spread over
 * many small entries). New folders and files are reported as they are.
 */
export function growthHotspots(tree, mountPath, {min = 100 * 1024 ** 2, limit = 12} = {}) {
  const out = [];
  const stack = [[tree, mountPath]];
  while (stack.length) {
    const [n, at] = stack.pop();
    const kids = n.nw ? [] : (n.ch || []).filter(c => c.n && (c.g ?? 0) >= min);
    const explained = kids.reduce((a, c) => a + c.g, 0);
    if (kids.length && explained >= 0.6 * n.g) { for (const c of kids) stack.push([c, path.posix.join(at, c.n)]); continue; }
    if (n !== tree && (n.g ?? 0) >= min) out.push({path: at, kind: n.k, growth: n.g, bytes: n.d, isNew: !!n.nw, newest: n.m || null});
  }
  return out.sort((a, b) => b.growth - a.growth).slice(0, limit);
}

