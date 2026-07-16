import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUNDLE_EXT, STATE_DIR } from './brand.mjs';
import { claudeDir, home } from './env.mjs';
import { build } from './pack.mjs';
import { seal } from './container.mjs';
import { pack as tarPack, validateEntries } from './tar.mjs';
import { MANIFEST_PATH } from './manifest.mjs';
import { summarize } from './scan.mjs';
import { graft } from './graft.mjs';
import { bytes, c, confirm, heading, sym, table } from './ui.mjs';

const BRAIN_SUBDIR = 'brain';

function git(args, cwd) {
  return execFileSync(
    'git',
    ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never', '-c', 'protocol.file.allow=user', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_ALLOW_PROTOCOL: 'https:ssh:git' }
    }
  ).trim();
}

const SAFE_REMOTE = /^(https:\/\/|git@[a-z0-9.-]+:|ssh:\/\/(?:[a-z0-9._-]+@)?[a-z0-9])/i;

export function assertSafeRemote(remote) {
  if (typeof remote !== 'string' || !SAFE_REMOTE.test(remote) || /[\r\n\0]/.test(remote)) {
    throw new Error(
      `refusing remote ${JSON.stringify(remote)} — only https://, ssh://, and git@host: URLs are allowed`
    );
  }
  return remote;
}

export function syncStatePath(dir = claudeDir()) {
  return path.join(dir, STATE_DIR, 'sync.json');
}

export function readSyncState(dir = claudeDir()) {
  try {
    return JSON.parse(fs.readFileSync(syncStatePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function writeSyncState(state, dir = claudeDir()) {
  fs.mkdirSync(path.dirname(syncStatePath(dir)), { recursive: true });
  fs.writeFileSync(syncStatePath(dir), `${JSON.stringify(state, null, 2)}\n`);
}

export function parseGitHub(remote) {
  const m = remote.match(/^(?:https:\/\/|git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function remoteVisibility(remote) {
  const gh = parseGitHub(remote);
  if (!gh) return { host: 'other', visibility: 'unknown' };
  try {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'claudeport' }
    });
    if (res.status === 200) return { host: 'github', visibility: 'public', ...gh };
    if (res.status === 404) return { host: 'github', visibility: 'private-or-missing', ...gh };
    return { host: 'github', visibility: 'unknown', status: res.status, ...gh };
  } catch {
    return { host: 'github', visibility: 'unreachable', ...gh };
  }
}

function repoDir() {
  return path.join(home(), '.claudeport', 'sync');
}

function ensureRepo(remote) {
  assertSafeRemote(remote);
  const dir = repoDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(['init', '-q'], dir);
    git(['remote', 'add', 'origin', remote], dir);
    try {
      git(['fetch', '--depth', '1', 'origin'], dir);
      const head = git(['rev-parse', '--verify', 'origin/HEAD'], dir).trim();
      if (head) git(['checkout', '-B', 'main', 'origin/HEAD'], dir);
    } catch {
      git(['checkout', '-B', 'main'], dir);
    }
  } else {
    const current = git(['remote', 'get-url', 'origin'], dir);
    if (current !== remote) {
      git(['remote', 'set-url', 'origin', remote], dir);
    }
  }
  return dir;
}

export async function push({ remote = null, yes = false, allowUnverifiedRemote = false } = {}) {
  const dir = claudeDir();
  const state = readSyncState(dir);
  const target = remote ?? state?.remote;
  if (!target) {
    process.stderr.write(`${sym.bad} no remote configured. Run: ${c.bold('claudeport sync push --remote <git-url>')}\n`);
    return 1;
  }
  try {
    assertSafeRemote(target);
  } catch (err) {
    process.stderr.write(`${sym.bad} ${c.red(err.message)}\n`);
    return 2;
  }

  if (state?.remote && remote && remote !== state.remote) {
    process.stdout.write(`${sym.warn} ${c.yellow('The remote changed')} ${c.gray(`(${state.remote} → ${remote})`)}\n`);
    const ok = await confirm('  Push your brain to the NEW remote?', { assumeYes: yes });
    if (!ok) return 1;
  }

  const vis = await remoteVisibility(target);
  if (vis.visibility === 'public') {
    process.stderr.write(
      `${sym.bad} ${c.red(c.bold('REFUSING TO PUSH: that repository is PUBLIC.'))}\n` +
      c.gray(`  ${target}\n`) +
      c.gray('  Your brain contains memory files — prose about your work and your life.\n') +
      c.gray('  Make the repository private, then run this again.\n')
    );
    return 2;
  }
  if (vis.visibility !== 'private-or-missing' && !allowUnverifiedRemote) {
    process.stderr.write(
      `${sym.bad} ${c.red('Cannot verify that this remote is private')} ${c.gray(`(${vis.host}, ${vis.visibility})`)}.\n` +
      c.gray('  Claudeport only auto-verifies GitHub. If you are certain it is private, pass --allow-unverified-remote.\n')
    );
    return 2;
  }

  const { manifest, files, findings } = build({ dir, h: home(), includeMemory: true });
  const { blocking } = summarize(findings);
  if (blocking.length) {
    process.stderr.write(`${sym.bad} ${c.red('secrets found — refusing to push')}\n`);
    for (const f of blocking.slice(0, 10)) {
      process.stderr.write(`  ${f.label} ${c.gray(`${f.file}:${f.line}`)}\n`);
    }
    return 2;
  }

  const repo = ensureRepo(target);
  const brainDir = path.join(repo, BRAIN_SUBDIR);
  fs.rmSync(brainDir, { recursive: true, force: true });
  fs.mkdirSync(brainDir, { recursive: true });

  for (const f of files) {
    const dest = path.join(brainDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
  fs.writeFileSync(path.join(repo, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    `# Claude brain (private)\n\nWritten by [claudeport](https://github.com/1mp3ctz/claudeport). Do not make this repository public.\n\n- files: ${files.length}\n- updated: ${new Date().toISOString()}\n`
  );
  fs.writeFileSync(path.join(repo, '.gitignore'), 'incoming*.brain\n');

  git(['add', '-A'], repo);
  let changed = true;
  try {
    git(['diff', '--cached', '--quiet'], repo);
    changed = false;
  } catch { /* diff --quiet exits non-zero when there are changes */ }

  if (!changed) {
    process.stdout.write(`\n  ${sym.ok} Remote is already up to date.\n\n`);
    writeSyncState({ remote: target, lastPush: new Date().toISOString(), digest: manifest.digest }, dir);
    return 0;
  }

  git(['-c', 'user.name=claudeport', '-c', 'user.email=claudeport@localhost', 'commit', '-q', '-m', `brain: ${new Date().toISOString()}`], repo);
  git(['push', '-u', 'origin', 'HEAD:main'], repo);

  writeSyncState({ remote: target, lastPush: new Date().toISOString(), digest: manifest.digest }, dir);

  process.stdout.write(`${heading('Pushed')}\n`);
  process.stdout.write(
    table([
      [sym.ok, 'remote', target],
      [sym.ok, 'visibility', c.green('private (verified)')],
      [sym.ok, 'files', `${files.length}`],
      [sym.ok, 'memory', `${manifest.entries.filter((e) => e.kind === 'memory').length} files`]
    ]) + '\n\n'
  );
  return 0;
}

export async function pull({ remote = null, apply = false, yes = false, trust = false, preferTheirs = false } = {}) {
  const dir = claudeDir();
  const state = readSyncState(dir);
  const target = remote ?? state?.remote;
  if (!target) {
    process.stderr.write(`${sym.bad} no remote configured. Run: ${c.bold('claudeport sync pull --remote <git-url>')}\n`);
    return 1;
  }
  try {
    assertSafeRemote(target);
  } catch (err) {
    process.stderr.write(`${sym.bad} ${c.red(err.message)}\n`);
    return 2;
  }

  const repo = ensureRepo(target);
  try {
    git(['fetch', 'origin'], repo);
    git(['reset', '--hard', 'origin/main'], repo);
  } catch (err) {
    process.stderr.write(`${sym.bad} ${c.red('git fetch failed')}: ${err.message.split('\n')[0]}\n`);
    return 1;
  }

  const manifestPath = path.join(repo, MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`${sym.bad} that remote has no claudeport manifest — is it the right repo?\n`);
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    process.stderr.write(`${sym.bad} the synced manifest is not valid JSON — the remote may be corrupted\n`);
    return 1;
  }

  const brainRoot = path.resolve(repo, BRAIN_SUBDIR);
  const files = [];
  for (const e of manifest.entries.filter((entry) => entry.type === 'file')) {
    const pathErrors = validateEntries([{ path: e.path }]);
    if (pathErrors.length) {
      process.stderr.write(`${sym.bad} ${c.red('unsafe path in synced manifest — refusing')}: ${e.path}\n`);
      return 2;
    }
    const abs = path.resolve(brainRoot, e.path);
    if (abs !== brainRoot && !abs.startsWith(brainRoot + path.sep)) {
      process.stderr.write(`${sym.bad} ${c.red('path escapes the synced brain root — refusing')}: ${e.path}\n`);
      return 2;
    }
    files.push({ path: e.path, type: 'file', data: fs.readFileSync(abs), mode: 0o644 });
  }

  const tarBuffer = tarPack([
    { path: MANIFEST_PATH, type: 'file', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mode: 0o644 },
    ...files
  ]);
  const sealed = seal({ tarBuffer, passphrase: null, manifestDigest: manifest.digest });

  const incoming = path.join(repo, `incoming${BUNDLE_EXT}`);
  fs.writeFileSync(incoming, sealed);

  const code = await graft(incoming, { apply, yes, trust, preferTheirs });
  try {
    fs.rmSync(incoming, { force: true });
  } catch { /* best effort */ }
  return code;
}
