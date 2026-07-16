import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, LEGACY_STATE_DIR } from './brand.mjs';
import { sha256 } from './crypto.mjs';
import { safeJoin } from './tar.mjs';

export function stateDir(claudeDir) {
  return path.join(claudeDir, STATE_DIR);
}

export function journalPath(claudeDir) {
  return path.join(stateDir(claudeDir), 'journal.json');
}

function legacyJournalPath(claudeDir) {
  return path.join(claudeDir, LEGACY_STATE_DIR, 'journal.json');
}

export function readJournal(claudeDir) {
  for (const p of [journalPath(claudeDir), legacyJournalPath(claudeDir)]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* try next */ }
  }
  return null;
}

function writeJournal(claudeDir, journal) {
  const dir = stateDir(claudeDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${journalPath(claudeDir)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(journal, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, journalPath(claudeDir));
}

export function txId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class Transaction {
  constructor(claudeDir, meta = {}) {
    this.claudeDir = claudeDir;
    this.id = txId();
    this.meta = meta;
    this.ops = [];
    this.snapshotDir = path.join(stateDir(claudeDir), 'snapshots', this.id);
    this.stageDir = path.join(stateDir(claudeDir), 'stage', this.id);
  }

  add(op) {
    this.ops.push(op);
  }

  linkAwareDest(rel) {
    const parts = rel.split('/');
    const root = fs.realpathSync(this.claudeDir);
    const insideRoot = (p) => p === root || p.startsWith(root + path.sep);
    let current = this.claudeDir;

    for (let i = 0; i < parts.length; i += 1) {
      const isLeaf = i === parts.length - 1;
      const next = path.join(current, parts[i]);
      let st;
      try {
        st = fs.lstatSync(next);
      } catch {
        current = next;
        continue;
      }
      if (st.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(next);
        } catch {
          return { dest: safeJoin(this.claudeDir, rel), throughLink: false, external: false, dangling: true };
        }
        const dest = isLeaf ? real : path.join(real, ...parts.slice(i + 1));
        return { dest, throughLink: true, external: !insideRoot(real) };
      }
      current = next;
    }
    return { dest: safeJoin(this.claudeDir, rel), throughLink: false, external: false };
  }

  commit({ allowExternalLinks = false } = {}) {
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    fs.mkdirSync(this.stageDir, { recursive: true });

    const journal = {
      id: this.id,
      status: 'staging',
      meta: this.meta,
      snapshotDir: this.snapshotDir,
      ops: []
    };
    writeJournal(this.claudeDir, journal);

    const staged = [];
    for (const op of this.ops) {
      if (!op.data) continue;
      const { dest, throughLink, external } = this.linkAwareDest(op.rel);
      if (external && !allowExternalLinks) {
        journal.ops.push({ rel: op.rel, action: 'refused-external-link', dest });
        continue;
      }

      const stagePath = path.join(this.stageDir, op.rel.replace(/\//g, '__'));
      fs.writeFileSync(stagePath, op.data);
      if (op.exec && process.platform !== 'win32') fs.chmodSync(stagePath, 0o755);

      let prevHash = null;
      let existed = false;
      try {
        const prev = fs.readFileSync(dest);
        prevHash = sha256(prev);
        existed = true;
        const snapPath = path.join(this.snapshotDir, op.rel.replace(/\//g, '__'));
        fs.writeFileSync(snapPath, prev);
      } catch { /* new file */ }

      staged.push({ op, dest, stagePath, prevHash, existed, throughLink });
      journal.ops.push({
        rel: op.rel,
        dest,
        action: existed ? (op.action ?? 'overwrite') : 'create',
        throughLink,
        prevHash,
        newHash: sha256(op.data),
        snapshot: existed ? op.rel.replace(/\//g, '__') : null,
        done: false
      });
    }

    journal.status = 'committing';
    writeJournal(this.claudeDir, journal);

    for (let i = 0; i < staged.length; i += 1) {
      const s = staged[i];
      fs.mkdirSync(path.dirname(s.dest), { recursive: true });
      fs.renameSync(s.stagePath, s.dest);
      const entry = journal.ops.find((o) => o.rel === s.op.rel && !o.done);
      if (entry) entry.done = true;
      writeJournal(this.claudeDir, journal);
    }

    journal.status = 'committed';
    journal.completed = new Date().toISOString();
    writeJournal(this.claudeDir, journal);

    try {
      fs.rmSync(this.stageDir, { recursive: true, force: true });
    } catch { /* best effort */ }

    return journal;
  }
}

export function undo(claudeDir) {
  const journal = readJournal(claudeDir);
  if (!journal) throw new Error('nothing to undo: no journal found');
  if (journal.status === 'undone') throw new Error('the last transaction was already undone');

  const restored = [];
  const removed = [];
  const failed = [];

  for (const op of [...journal.ops].reverse()) {
    if (!op.done) continue;
    try {
      if (op.snapshot) {
        const snap = path.join(journal.snapshotDir, op.snapshot);
        const bytes = fs.readFileSync(snap);
        fs.writeFileSync(op.dest, bytes);
        restored.push(op.rel);
      } else {
        fs.rmSync(op.dest, { force: true });
        removed.push(op.rel);
      }
    } catch (err) {
      failed.push({ rel: op.rel, error: err.message });
    }
  }

  journal.status = 'undone';
  journal.undoneAt = new Date().toISOString();
  writeJournal(claudeDir, journal);

  try {
    fs.rmSync(path.join(stateDir(claudeDir), 'stage', journal.id), { recursive: true, force: true });
  } catch { /* best effort */ }

  return { restored, removed, failed, id: journal.id };
}

export function pendingRecovery(claudeDir) {
  const journal = readJournal(claudeDir);
  if (!journal) return null;
  if (journal.status === 'committed' || journal.status === 'undone') return null;
  return journal;
}
