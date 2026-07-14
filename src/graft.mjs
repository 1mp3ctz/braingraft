import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './brand.mjs';
import { claudeDir, home, homeNamespace } from './env.mjs';
import { landingPathFor } from './memory.mjs';
import { detokenizeHome, inferExec } from './rewrite.mjs';
import { localKeysPreserved, mergeSettings } from './settings.mjs';
import { sha256 } from './crypto.mjs';
import { Transaction, pendingRecovery } from './journal.mjs';
import { foreignBundle, load } from './inspect.mjs';
import { bytes, c, confirm, heading, sym, table } from './ui.mjs';

const SPECIAL = new Set(['settings.json', 'mcp.lock.json', 'env.example']);

export function plan({ bundle, dir = claudeDir(), h = home(), preferTheirs = false }) {
  const ops = [];
  const skipped = [];
  const notes = { mcp: null, envExample: null, settingsReport: [] };

  for (const file of bundle.files) {
    if (SPECIAL.has(file.path)) continue;

    const target = file.path.startsWith('memory/') ? landingPathFor(file.path, h) : file.path;
    if (!target) {
      skipped.push({ rel: file.path, reason: 'unmappable memory path' });
      continue;
    }

    const entry = bundle.manifest.entries.find((e) => e.path === file.path);
    const isText = entry?.text ?? false;
    const data = isText
      ? Buffer.from(detokenizeHome(file.data.toString('utf8'), h), 'utf8')
      : file.data;

    const abs = path.join(dir, target);
    let existing = null;
    try {
      existing = fs.readFileSync(abs);
    } catch { /* new */ }

    if (existing && sha256(existing) === sha256(data)) {
      ops.push({ rel: target, action: 'identical', data: null, size: data.length });
      continue;
    }

    if (existing && !preferTheirs) {
      ops.push({ rel: target, action: 'conflict-keep-yours', data: null, size: data.length });
      continue;
    }

    ops.push({
      rel: target,
      action: existing ? 'overwrite' : 'create',
      data,
      size: data.length,
      exec: inferExec(target, data)
    });
  }

  const settingsFile = bundle.files.find((f) => f.path === 'settings.json');
  if (settingsFile) {
    const incomingText = detokenizeHome(settingsFile.data.toString('utf8'), h);
    let incoming = null;
    try {
      incoming = JSON.parse(incomingText);
    } catch {
      skipped.push({ rel: 'settings.json', reason: 'bundle settings.json is not valid JSON' });
    }
    if (incoming) {
      const settingsPath = path.join(dir, 'settings.json');
      let current = {};
      let currentRaw = null;
      try {
        currentRaw = fs.readFileSync(settingsPath, 'utf8');
        current = JSON.parse(currentRaw);
      } catch { /* fresh machine or unreadable */ }

      const { merged, report } = mergeSettings(current, incoming);
      notes.settingsReport = report;

      if (!localKeysPreserved(current, merged)) {
        skipped.push({ rel: 'settings.json', reason: 'refused: merge would have altered machine-local keys' });
      } else {
        const nextRaw = `${JSON.stringify(merged, null, 2)}\n`;
        JSON.parse(nextRaw);
        if (currentRaw !== null && sha256(Buffer.from(currentRaw)) === sha256(Buffer.from(nextRaw))) {
          ops.push({ rel: 'settings.json', action: 'identical', data: null, size: nextRaw.length });
        } else {
          ops.push({
            rel: 'settings.json',
            action: currentRaw === null ? 'create' : 'merge',
            data: Buffer.from(nextRaw, 'utf8'),
            size: nextRaw.length
          });
        }
      }
    }
  }

  const quarantine = (rel, data) => {
    const abs = path.join(dir, rel);
    let existing = null;
    try {
      existing = fs.readFileSync(abs);
    } catch { /* new */ }
    if (existing && sha256(existing) === sha256(data)) {
      ops.push({ rel, action: 'identical', data: null, size: data.length });
      return;
    }
    ops.push({ rel, action: 'quarantine', data, size: data.length });
  };

  const mcpFile = bundle.files.find((f) => f.path === 'mcp.lock.json');
  if (mcpFile) {
    const text = detokenizeHome(mcpFile.data.toString('utf8'), h);
    notes.mcp = text;
    quarantine(`${STATE_DIR}/pending-mcp.json`, Buffer.from(text, 'utf8'));
  }

  const envFile = bundle.files.find((f) => f.path === 'env.example');
  if (envFile) {
    notes.envExample = envFile.data.toString('utf8');
    quarantine(`${STATE_DIR}/env.example`, envFile.data);
  }

  return { ops, skipped, notes };
}

function summarizeOps(ops) {
  const by = (a) => ops.filter((o) => o.action === a);
  return {
    create: by('create'),
    overwrite: by('overwrite'),
    merge: by('merge'),
    identical: by('identical'),
    conflicts: by('conflict-keep-yours'),
    quarantine: by('quarantine')
  };
}

export async function graft(file, {
  apply = false,
  preferTheirs = false,
  trust = false,
  passphrase = null,
  yes = false,
  json = false,
  allowExternalLinks = false
} = {}) {
  const dir = claudeDir();
  const h = home();

  const stale = pendingRecovery(dir);
  if (stale) {
    process.stderr.write(
      `${sym.bad} ${c.red('A previous graft did not finish')} (${stale.id}, status ${stale.status}).\n` +
      `  Run ${c.bold('claudeport undo')} first — it will roll it back from the journal.\n`
    );
    return 1;
  }

  let bundle;
  try {
    bundle = load(file, { passphrase });
  } catch (err) {
    process.stderr.write(`${sym.bad} ${c.red(err.message)}\n`);
    return 1;
  }

  if (bundle.problems.length) {
    process.stderr.write(`${sym.bad} ${c.red('bundle failed its integrity check — refusing to graft')}\n`);
    for (const p of bundle.problems.slice(0, 10)) {
      process.stderr.write(`  ${p.path}: ${p.reason}\n`);
    }
    return 2;
  }

  const isForeign = foreignBundle(bundle.manifest);
  const { ops, skipped, notes } = plan({ bundle, dir, h, preferTheirs });
  const s = summarizeOps(ops);
  const memoryOps = ops.filter((o) => o.rel.includes('/memory/'));

  if (json) {
    process.stdout.write(`${JSON.stringify({
      apply,
      foreign: isForeign,
      ops: ops.map(({ data, ...rest }) => rest),
      skipped,
      settings: notes.settingsReport
    }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${heading(apply ? 'Grafting' : 'Plan (dry run — nothing is written)')}\n`);
  process.stdout.write(
    table([
      [sym.ok, c.green('create'), `${s.create.length}`, c.gray('new files')],
      [s.merge.length ? sym.ok : sym.info, c.cyan('merge'), `${s.merge.length}`, c.gray('settings.json, key-by-key')],
      [s.overwrite.length ? sym.warn : sym.info, c.yellow('overwrite'), `${s.overwrite.length}`, c.gray(preferTheirs ? '--theirs was passed' : 'none')],
      [s.conflicts.length ? sym.warn : sym.info, c.yellow('kept yours'), `${s.conflicts.length}`, c.gray('differ from the bundle; pass --theirs to take theirs')],
      [sym.info, c.gray('identical'), `${s.identical.length}`, c.gray('already match')],
      [s.quarantine.length ? sym.warn : sym.info, c.magenta('quarantined'), `${s.quarantine.length}`, c.gray('MCP/env — written aside, never activated')]
    ]) + '\n'
  );

  if (memoryOps.filter((o) => o.data).length) {
    process.stdout.write(
      `\n  ${sym.ok} ${c.bold(`${memoryOps.filter((o) => o.data).length} memory files`)} land in ${c.bold(`projects/${homeNamespace(h)}/memory/`)} ${c.gray('— the namespace Claude reads on THIS machine.')}\n`
    );
  }

  const writes = ops.filter((o) => o.data);
  if (writes.length) {
    process.stdout.write(`\n${c.gray('  Files that would be written:')}\n`);
    process.stdout.write(
      table(
        writes.slice(0, 25).map((o) => [
          o.action === 'create' ? c.green('+') : o.action === 'merge' ? c.cyan('~') : o.action === 'quarantine' ? c.magenta('q') : c.yellow('!'),
          o.rel,
          c.gray(bytes(o.size)),
          o.exec ? c.yellow('executable') : ''
        ])
      ) + '\n'
    );
    if (writes.length > 25) process.stdout.write(c.gray(`  … and ${writes.length - 25} more\n`));
  }

  const execs = bundle.observed.filter((o) => o.exec);
  const instructions = bundle.observed.filter((o) => o.instruction);
  const requestsMcp = (bundle.manifest.locks?.mcp ?? []).length > 0 || Boolean(notes.mcp);
  const carriesCode = execs.length > 0 || instructions.length > 0 || requestsMcp;

  if (carriesCode) {
    process.stdout.write(`\n${heading(isForeign ? 'This bundle came from another machine' : 'This bundle installs code and instructions')}\n`);
    process.stdout.write(
      `  ${c.red(c.bold('Grafting it is equivalent to running unreviewed code.'))}\n` +
      c.gray(`  ${execs.length} executable file(s) become hooks/scripts Claude Code can run.\n`) +
      c.gray(`  ${instructions.length} instruction file(s) steer the model on every prompt — no scanner can tell a\n`) +
      c.gray('  malicious instruction from a legitimate one.\n') +
      (isForeign ? c.yellow('  The bundle also claims a different origin machine than this one.\n') : '') +
      `  ${sym.arrow} Read them first: ${c.bold(`claudeport inspect ${path.basename(file)}`)}\n`
    );
    if (apply && !trust) {
      process.stderr.write(
        `\n${sym.bad} ${c.red('Refusing to apply without --trust.')} ${c.gray('This bundle runs code and loads instructions on this machine.')}\n` +
        c.gray(`  If you have reviewed it, re-run with ${c.bold('--trust')}.\n\n`)
      );
      return 2;
    }
  }

  if (skipped.length) {
    process.stdout.write(`\n${c.yellow('  Skipped:')}\n`);
    for (const sk of skipped.slice(0, 10)) {
      process.stdout.write(`  ${sym.warn} ${sk.rel} ${c.gray(sk.reason)}\n`);
    }
  }

  if (!apply) {
    process.stdout.write(`\n  ${sym.arrow} Nothing was written. Run it for real: ${c.bold(`claudeport graft ${path.basename(file)} --apply`)}\n\n`);
    return 0;
  }

  if (!writes.length) {
    process.stdout.write(`\n  ${sym.ok} Nothing to do — this machine already matches the bundle.\n\n`);
    return 0;
  }

  const ok = await confirm(`\n  Write ${writes.length} file(s) into ${dir}?`, { assumeYes: yes });
  if (!ok) {
    process.stderr.write(`${sym.bad} aborted (nothing written)\n`);
    return 1;
  }

  const tx = new Transaction(dir, { bundle: path.basename(file), digest: bundle.manifest.digest, foreign: isForeign });
  for (const op of writes) tx.add(op);
  const journal = tx.commit({ allowExternalLinks });

  const refused = journal.ops.filter((o) => o.action === 'refused-external-link');
  const done = journal.ops.filter((o) => o.done);

  process.stdout.write(`\n  ${sym.ok} ${c.green(`${done.length} file(s) written`)} ${c.gray(`(transaction ${journal.id})`)}\n`);
  if (refused.length) {
    process.stdout.write(`  ${sym.warn} ${refused.length} refused: the path is a symlink pointing outside your Claude directory.\n`);
    process.stdout.write(c.gray('    Pass --allow-external-links if that is genuinely what you want.\n'));
  }
  if (notes.mcp) {
    process.stdout.write(`\n  ${sym.warn} ${c.yellow('MCP servers, plugins, and marketplaces were NOT enabled.')} They are in ${c.bold(`${STATE_DIR}/pending-mcp.json`)}.\n`);
    process.stdout.write(c.gray('    Each one runs code or grants a plugin source. Review them, then add the ones you trust to settings.json yourself.\n'));
  }
  if (notes.envExample) {
    process.stdout.write(`  ${sym.info} Redacted values are listed in ${c.bold(`${STATE_DIR}/env.example`)} — set them as environment variables.\n`);
  }
  process.stdout.write(`\n  ${sym.arrow} Changed your mind? ${c.bold('claudeport undo')} restores this machine exactly.\n\n`);
  return 0;
}
