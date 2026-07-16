import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './env.mjs';

export const PRUNE_DIRS = new Set([
  'jobs', 'cache', 'plugins', 'node_modules', '.git', 'shell-snapshots', 'file-history',
  'backups', 'downloads', 'ide', 'paste-cache', 'image-cache', 'todos', 'statsig',
  'session-env', 'daemon', 'telemetry', '.braingraft', '.claudeport', 'tasks'
]);

const MAX_ENTRIES = 200000;

export function walk(root, { prune = PRUNE_DIRS, prunePath = null } = {}) {
  const entries = [];
  const seenDirs = new Set();
  const skipped = [];

  const visit = (absDir, relDir, depth) => {
    if (depth > 64) {
      skipped.push({ path: relDir, reason: 'max-depth' });
      return;
    }
    let dirents;
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: relDir, reason: `unreadable: ${err.code || err.message}` });
      return;
    }
    for (const d of dirents) {
      if (entries.length > MAX_ENTRIES) {
        skipped.push({ path: relDir, reason: 'entry-cap' });
        return;
      }
      const abs = path.join(absDir, d.name);
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (err) {
        skipped.push({ path: rel, reason: `unstattable: ${err.code || err.message}` });
        continue;
      }

      if (st.isSymbolicLink()) {
        let target = null;
        let resolves = false;
        try {
          target = fs.readlinkSync(abs);
        } catch { /* unreadable link */ }
        try {
          fs.statSync(abs);
          resolves = true;
        } catch { /* dangling */ }
        entries.push({ rel: toPosix(rel), abs, type: 'link', target, resolves, size: 0, mode: st.mode });
        continue;
      }

      if (st.isDirectory()) {
        if (prune.has(d.name) || (prunePath && prunePath(toPosix(rel)))) {
          skipped.push({ path: toPosix(rel), reason: 'pruned' });
          continue;
        }
        let realKey;
        try {
          const real = fs.realpathSync(abs);
          const rst = fs.statSync(real);
          realKey = `${rst.dev}:${rst.ino}`;
        } catch {
          realKey = abs;
        }
        if (realKey !== '0:0' && seenDirs.has(realKey)) {
          skipped.push({ path: rel, reason: 'cycle' });
          continue;
        }
        if (realKey !== '0:0') seenDirs.add(realKey);
        entries.push({ rel: toPosix(rel), abs, type: 'dir', size: 0, mode: st.mode });
        visit(abs, rel, depth + 1);
        continue;
      }

      if (st.isFile()) {
        entries.push({ rel: toPosix(rel), abs, type: 'file', size: st.size, mode: st.mode, mtime: st.mtimeMs });
        continue;
      }

      skipped.push({ path: rel, reason: 'special-file' });
    }
  };

  visit(root, '', 0);
  return { entries, skipped };
}

export function dirSize(root) {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile()) {
        bytes += st.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}
