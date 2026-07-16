import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_EXT, VERSION, NAME, IGNORE_FILE, LEGACY_IGNORE_FILE } from './brand.mjs';
import { claudeDir, home, homeNamespace, platform } from './env.mjs';
import { walk } from './walk.mjs';
import { BRAIN, MEMORY, SECRET, classify, isExecutable, isInstructionFile, memoryNamespaceOf } from './classify.mjs';
import { activeNamespace, bundlePathFor, diagnose } from './memory.mjs';
import { findForeignPaths, inferExec, isTextPath, looksBinary, normalizeEol, tokenizeHome } from './rewrite.mjs';
import { BLOCK, scanText, summarize } from './scan.mjs';
import { sanitizeSettings } from './settings.mjs';
import { sha256 } from './crypto.mjs';
import { MANIFEST_PATH, buildManifest } from './manifest.mjs';
import { pack as tarPack } from './tar.mjs';
import { seal } from './container.mjs';
import { bytes, c, confirm, heading, sym, table } from './ui.mjs';

const MAX_FILE = 16 * 1024 * 1024;

function loadIgnore(dir) {
  let patterns = [];
  for (const name of [IGNORE_FILE, LEGACY_IGNORE_FILE]) {
    try {
      patterns = fs.readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      if (patterns.length) break;
    } catch { /* try next */ }
  }
  return (rel) => patterns.some((p) => matchGlob(rel, p));
}

export function matchGlob(rel, pattern) {
  const norm = pattern.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!norm) return false;
  const re = new RegExp(
    `^${norm
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*')
      .replace(/\?/g, '[^/]')}$`
  );
  return re.test(rel) || rel === norm || rel.startsWith(`${norm}/`);
}

export function build({ dir = claudeDir(), h = home(), includeMemory = true } = {}) {
  const ignored = loadIgnore(dir);
  const { entries } = walk(dir, {
    prunePath: (rel) => /^projects\/[^/]+\/(?!memory(\/|$))/.test(rel)
  });

  const files = [];
  const manifestEntries = [];
  const findings = [];
  const notes = { skippedSecrets: [], symlinks: [], foreignPaths: [], excluded: [], memoryConflicts: [] };
  const memoryByBundlePath = new Map();

  let settingsRaw = null;

  for (const e of entries) {
    if (e.type === 'dir') continue;

    if (e.type === 'link') {
      notes.symlinks.push({ rel: e.rel, target: e.target });
      continue;
    }

    const { kind } = classify(e.rel);
    if (kind === SECRET) {
      notes.skippedSecrets.push(e.rel);
      continue;
    }
    if (kind !== BRAIN && kind !== MEMORY) continue;
    if (kind === MEMORY && !includeMemory) continue;
    if (ignored(e.rel)) {
      notes.excluded.push(e.rel);
      continue;
    }
    if (e.size > MAX_FILE) {
      notes.excluded.push(`${e.rel} (over ${bytes(MAX_FILE)})`);
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(e.abs);
    } catch {
      notes.excluded.push(`${e.rel} (unreadable)`);
      continue;
    }

    if (e.rel === 'settings.json') {
      settingsRaw = buf.toString('utf8');
      continue;
    }

    let data = buf;
    let text = false;
    let eol = 'lf';

    if (isTextPath(e.rel) && !looksBinary(buf)) {
      text = true;
      const normalized = normalizeEol(buf.toString('utf8'));
      eol = normalized.eol;
      const tokenized = tokenizeHome(normalized.text, h);
      findings.push(...scanText(e.rel, tokenized.text));
      for (const p of findForeignPaths(tokenized.text)) notes.foreignPaths.push({ file: e.rel, path: p });
      data = Buffer.from(tokenized.text, 'utf8');
    }

    let bundlePath = e.rel;
    if (kind === MEMORY) {
      const ns = memoryNamespaceOf(e.rel);
      const rel = e.rel.slice(`projects/${ns}/memory/`.length);
      const nsIsActive = ns === activeNamespace(h);
      bundlePath = bundlePathFor(ns, rel, h);
      const prior = memoryByBundlePath.get(bundlePath);
      if (prior) {
        if (prior.active || !nsIsActive) {
          notes.memoryConflicts.push({ path: bundlePath, kept: prior.rel, dropped: e.rel });
          continue;
        }
        notes.memoryConflicts.push({ path: bundlePath, kept: e.rel, dropped: prior.rel });
        const idx = files.findIndex((f) => f.path === bundlePath);
        if (idx !== -1) files.splice(idx, 1);
        const midx = manifestEntries.findIndex((m) => m.path === bundlePath);
        if (midx !== -1) manifestEntries.splice(midx, 1);
      }
      memoryByBundlePath.set(bundlePath, { rel: e.rel, mtime: e.mtime, active: nsIsActive });
    }

    files.push({ path: bundlePath, type: 'file', data, mode: 0o644 });
    manifestEntries.push({
      path: bundlePath,
      source: e.rel,
      type: 'file',
      kind,
      size: data.length,
      sha256: sha256(data),
      text,
      eol,
      exec: isExecutable(e.rel, buf) && inferExec(e.rel, buf),
      instruction: isInstructionFile(e.rel)
    });
  }

  let settings = { shared: {}, quarantined: {}, local: [], unknown: [], redactions: [], envExample: {}, foreign: [] };
  if (settingsRaw !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(settingsRaw);
    } catch {
      notes.excluded.push('settings.json (not valid JSON)');
    }
    if (parsed) {
      settings = sanitizeSettings(parsed);
      const tokenized = tokenizeHome(JSON.stringify(settings.shared, null, 2), h);
      const sharedBuf = Buffer.from(tokenized.text, 'utf8');
      findings.push(...scanText('settings.json', tokenized.text));
      files.push({ path: 'settings.json', type: 'file', data: sharedBuf, mode: 0o644 });
      manifestEntries.push({
        path: 'settings.json',
        source: 'settings.json',
        type: 'file',
        kind: BRAIN,
        size: sharedBuf.length,
        sha256: sha256(sharedBuf),
        text: true,
        eol: 'lf',
        exec: false,
        instruction: false,
        merge: 'settings'
      });

      if (Object.keys(settings.quarantined).length) {
        const mcpText = tokenizeHome(JSON.stringify(settings.quarantined, null, 2), h).text;
        const mcpBuf = Buffer.from(mcpText, 'utf8');
        findings.push(...scanText('mcp.lock.json', mcpText));
        files.push({ path: 'mcp.lock.json', type: 'file', data: mcpBuf, mode: 0o644 });
        manifestEntries.push({
          path: 'mcp.lock.json',
          source: 'settings.json#mcpServers',
          type: 'file',
          kind: BRAIN,
          size: mcpBuf.length,
          sha256: sha256(mcpBuf),
          text: true,
          eol: 'lf',
          exec: false,
          instruction: false,
          quarantine: true
        });
      }

      if (Object.keys(settings.envExample).length) {
        const envText = `${Object.keys(settings.envExample).sort().map((k) => `${k}=`).join('\n')}\n`;
        const envBuf = Buffer.from(envText, 'utf8');
        files.push({ path: 'env.example', type: 'file', data: envBuf, mode: 0o644 });
        manifestEntries.push({
          path: 'env.example',
          source: 'settings.json (redacted values)',
          type: 'file',
          kind: BRAIN,
          size: envBuf.length,
          sha256: sha256(envBuf),
          text: true,
          eol: 'lf',
          exec: false,
          instruction: false
        });
      }
      const settingsText = JSON.stringify({ ...settings.shared, ...settings.quarantined }, null, 2);
      for (const p of findForeignPaths(tokenizeHome(settingsText, h).text)) {
        notes.foreignPaths.push({ file: 'settings.json', path: p });
      }
    }
  }

  const mem = diagnose(dir, h);
  const origin = {
    tool: `braingraft/${VERSION}`,
    os: platform(),
    namespace: homeNamespace(h),
    memoryNamespaces: mem.namespaces.map((n) => ({ ns: n.ns, files: n.files, bytes: n.bytes, os: n.os })),
    includeMemory
  };

  const manifest = buildManifest({
    origin,
    entries: manifestEntries,
    settings: {
      shared: Object.keys(settings.shared),
      localSkipped: settings.local,
      unknownSkipped: settings.unknown,
      redacted: settings.redactions,
      quarantined: Object.keys(settings.quarantined)
    },
    locks: { mcp: Object.keys(settings.quarantined.mcpServers ?? {}) },
    findings,
    notes
  });

  return { manifest, files, findings, notes, settings, memory: mem };
}

export async function pack({ out, encrypt = false, passphrase = null, includeMemory = true, yes = false, json = false } = {}) {
  const dir = claudeDir();
  const h = home();
  if (!fs.existsSync(dir)) {
    process.stderr.write(`${sym.bad} no Claude Code config at ${dir}\n`);
    return 1;
  }

  const { manifest, files, findings, notes, settings } = build({ dir, h, includeMemory });
  const { blocking, warnings } = summarize(findings);

  if (blocking.length) {
    process.stderr.write(`${heading('Refusing to pack — secrets found')}\n`);
    for (const f of blocking) {
      process.stderr.write(`  ${sym.bad} ${c.red(f.label)} ${c.gray(`${f.file}:${f.line}`)}  ${c.gray(f.excerpt)}\n`);
    }
    process.stderr.write(
      `\n  Remove them, move them into environment variables, or exclude the file with ${c.bold('.claudeportignore')}.\n` +
      `  ${c.gray('There is no flag to override this.')}\n`
    );
    return 2;
  }

  const memoryFiles = manifest.entries.filter((e) => e.kind === 'memory');
  if (memoryFiles.length && !yes) {
    process.stdout.write(`${heading('Private content leaving this machine')}\n`);
    process.stdout.write(
      table(
        memoryFiles.slice(0, 20).map((e) => [sym.warn, e.path, c.gray(bytes(e.size))])
      ) + '\n'
    );
    if (memoryFiles.length > 20) process.stdout.write(c.gray(`  … and ${memoryFiles.length - 20} more\n`));
    process.stdout.write(
      c.gray('\n  Memory files are prose you wrote about your work and your life. Nothing redacts them.\n') +
      c.gray(`  Pack without them with ${c.bold('--no-memory')}.\n\n`)
    );
    const ok = await confirm('Include these in the bundle?');
    if (!ok) {
      process.stderr.write(`${sym.bad} aborted (no bundle written)\n`);
      return 1;
    }
  }

  const tarBuffer = tarPack([
    { path: MANIFEST_PATH, type: 'file', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mode: 0o644 },
    ...files
  ]);

  const sealed = seal({ tarBuffer, passphrase: encrypt ? passphrase : null, manifestDigest: manifest.digest });
  const target = path.resolve(out ?? `claude-brain${BUNDLE_EXT}`);
  fs.writeFileSync(target, sealed);

  if (json) {
    process.stdout.write(`${JSON.stringify({ out: target, entries: manifest.entries.length, bytes: sealed.length, encrypted: encrypt, warnings }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${heading('Packed')}\n`);
  process.stdout.write(
    table([
      [sym.ok, 'bundle', c.bold(target)],
      [sym.ok, 'entries', `${manifest.entries.length} files`],
      [sym.ok, 'size', bytes(sealed.length)],
      [sym.ok, 'memory', `${memoryFiles.length} files`],
      [encrypt ? sym.ok : sym.info, 'encrypted', encrypt ? c.green('AES-256-GCM') : c.gray('no')],
      [notes.skippedSecrets.length ? sym.ok : sym.info, 'credentials', c.gray(`${notes.skippedSecrets.length} skipped (never packable)`)]
    ]) + '\n'
  );

  if (warnings.length) {
    process.stdout.write(`\n${c.yellow(`${warnings.length} warning(s):`)}\n`);
    for (const f of warnings.slice(0, 8)) {
      process.stdout.write(`  ${sym.warn} ${f.label} ${c.gray(`${f.file}:${f.line}`)}\n`);
    }
  }
  if (notes.foreignPaths.length) {
    process.stdout.write(`\n  ${sym.warn} ${notes.foreignPaths.length} path(s) point at another machine's filesystem and were left as-is.\n`);
  }
  if (notes.symlinks.length) {
    process.stdout.write(`  ${sym.info} ${notes.symlinks.length} symlink(s) recorded, not followed.\n`);
  }
  if (settings.unknown?.length) {
    process.stdout.write(`  ${sym.info} ${settings.unknown.length} unrecognized settings key(s) not packed: ${c.gray(settings.unknown.join(', '))}\n`);
  }
  if (settings.quarantined && Object.keys(settings.quarantined).length) {
    process.stdout.write(`  ${sym.info} quarantined (need manual enable on graft): ${c.gray(Object.keys(settings.quarantined).join(', '))}\n`);
  }
  if (notes.memoryConflicts.length) {
    process.stdout.write(`  ${sym.warn} ${notes.memoryConflicts.length} memory file(s) existed in more than one namespace; kept the active machine's copy.\n`);
  }

  process.stdout.write(`\n  ${sym.arrow} On the other machine: ${c.bold(`braingraft graft ${path.basename(target)}`)}\n\n`);
  return 0;
}
