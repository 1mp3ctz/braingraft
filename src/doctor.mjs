import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, home, homeNamespace, platform } from './env.mjs';
import { walk } from './walk.mjs';
import { BRAIN, LOCAL, MEMORY, SECRET, UNKNOWN, classify } from './classify.mjs';
import { diagnose } from './memory.mjs';
import { BLOCK, summarize } from './scan.mjs';
import { build } from './pack.mjs';
import { bytes, c, heading, sym, table } from './ui.mjs';

export function collect({ dir = claudeDir(), h = home() } = {}) {
  const exists = fs.existsSync(dir);
  if (!exists) return { exists: false, dir };

  const { entries, skipped } = walk(dir, {
    prunePath: (rel) => /^projects\/[^/]+\/(?!memory(\/|$))/.test(rel)
  });

  const buckets = {
    [BRAIN]: { files: 0, bytes: 0, paths: [] },
    [MEMORY]: { files: 0, bytes: 0, paths: [] },
    [LOCAL]: { files: 0, bytes: 0, paths: [] },
    [SECRET]: { files: 0, bytes: 0, paths: [] },
    [UNKNOWN]: { files: 0, bytes: 0, paths: [] }
  };

  const links = [];

  for (const e of entries) {
    if (e.type === 'dir') continue;
    if (e.type === 'link') {
      links.push({ rel: e.rel, target: e.target, resolves: e.resolves });
      continue;
    }
    const { kind } = classify(e.rel);
    const bucket = buckets[kind];
    bucket.files += 1;
    bucket.bytes += e.size;
    if (bucket.paths.length < 5000) bucket.paths.push(e.rel);
  }

  const packed = build({ dir, h, includeMemory: true });
  const findings = packed.findings;
  const foreignPaths = packed.notes.foreignPaths;
  const memory = diagnose(dir, h);

  return {
    exists: true,
    dir,
    home: h,
    platform: platform(),
    namespace: homeNamespace(h),
    buckets,
    links,
    findings,
    foreignPaths: foreignPaths.slice(0, 40),
    skipped,
    memory
  };
}

export function render(result) {
  if (!result.exists) {
    return {
      text: `${sym.bad} No Claude Code config found at ${c.bold(result.dir)}\n  Nothing to diagnose. Is Claude Code installed for this user?`,
      code: 1
    };
  }

  const lines = [];
  const { memory, buckets, findings } = result;
  const secrets = summarize(findings);

  lines.push(heading('Machine'));
  lines.push(
    table([
      [c.gray('config'), result.dir],
      [c.gray('home'), result.home],
      [c.gray('platform'), result.platform],
      [c.gray('memory namespace'), c.bold(result.namespace)]
    ])
  );

  lines.push(heading('Memory'));
  if (memory.namespaces.length === 0) {
    lines.push(`  ${sym.info} No memory directories found. Nothing is at risk.`);
  } else {
    const rows = memory.namespaces.map((n) => {
      const state = n.isActive
        ? c.green('ACTIVE — Claude reads this')
        : memory.invisible.includes(n)
          ? c.red('INVISIBLE — Claude cannot see this')
          : c.gray('linked to the active namespace');
      return [
        n.isActive ? sym.ok : memory.invisible.includes(n) ? sym.bad : sym.info,
        n.ns,
        c.gray(`${n.os}`),
        `${n.files} files`,
        bytes(n.bytes),
        n.isLink ? c.gray('(link)') : '',
        state
      ];
    });
    lines.push(table(rows));
  }

  if (memory.invisible.length) {
    lines.push('');
    lines.push(
      `  ${c.red(c.bold(`${bytes(memory.invisibleBytes)} of memory (${memory.invisibleFiles} files) is on this disk but invisible to Claude.`))}`
    );
    lines.push(
      c.gray(
        '  Claude Code looks up memory by a directory named after this machine\'s home path.\n' +
        '  Memory written on another machine lands under that machine\'s name and is never read.\n' +
        '  See anthropics/claude-code#25739.'
      )
    );
    lines.push(`  ${sym.arrow} Fix it: ${c.bold('braingraft pack')} on the source machine, ${c.bold('braingraft graft')} here.`);
  } else if (memory.activeExists) {
    lines.push('');
    lines.push(`  ${sym.ok} All memory on this disk is in the namespace Claude actually reads.`);
  }

  lines.push(heading('What is portable'));
  lines.push(
    table([
      [sym.ok, c.bold('brain'), `${buckets.brain.files} files`, bytes(buckets.brain.bytes), c.gray('config you authored — packs')],
      [sym.ok, c.bold('memory'), `${buckets.memory.files} files`, bytes(buckets.memory.bytes), c.gray('auto-memory — packs (remapped)')],
      [sym.info, c.gray('local'), `${buckets.local.files} files`, bytes(buckets.local.bytes), c.gray('machine state — never packs')],
      [sym.bad, c.red('secret'), `${buckets.secret.files} files`, bytes(buckets.secret.bytes), c.gray('credentials — never packs, no flag')],
      [sym.warn, c.gray('unknown'), `${buckets.unknown.files} files`, bytes(buckets.unknown.bytes), c.gray('not in the allowlist — skipped')]
    ])
  );

  if (result.links.length) {
    lines.push(heading('Symlinks (recorded, never followed)'));
    lines.push(
      table(
        result.links.slice(0, 12).map((l) => [
          l.resolves ? sym.info : sym.warn,
          l.rel,
          c.gray(sym.arrow),
          c.gray(l.target ?? '?'),
          l.resolves ? '' : c.yellow('dangling')
        ])
      )
    );
  }

  lines.push(heading('Secrets'));
  if (secrets.blocking.length === 0 && secrets.warnings.length === 0) {
    lines.push(`  ${sym.ok} No key-shaped secrets found in the portable set.`);
  } else {
    for (const f of secrets.blocking.slice(0, 15)) {
      lines.push(`  ${sym.bad} ${c.red(f.label)} ${c.gray(`${f.file}:${f.line}`)}  ${c.gray(f.excerpt)}`);
    }
    for (const f of secrets.warnings.slice(0, 10)) {
      lines.push(`  ${sym.warn} ${c.yellow(f.label)} ${c.gray(`${f.file}:${f.line}`)}  ${c.gray(f.excerpt)}`);
    }
    if (secrets.blocking.length) {
      lines.push(`  ${sym.arrow} ${c.bold('pack refuses to run')} until these are gone or excluded via .claudeportignore.`);
    }
  }

  if (result.foreignPaths.length) {
    lines.push(heading('Paths that will not survive a move'));
    lines.push(
      table(
        result.foreignPaths.slice(0, 10).map((f) => [sym.warn, c.gray(f.file), f.path])
      )
    );
    lines.push(c.gray('  These point at another machine\'s filesystem. Braingraft reports them; it will not silently rewrite them.'));
  }

  lines.push('');
  const code = memory.invisible.length || secrets.blocking.length ? 2 : 0;
  return { text: lines.join('\n'), code };
}

export async function doctor({ json = false } = {}) {
  const result = collect();
  if (json) {
    const { text, code } = { text: '', code: result.exists && (result.memory?.invisible.length || result.findings?.some((f) => f.level === BLOCK)) ? 2 : result.exists ? 0 : 1 };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return code;
  }
  const { text, code } = render(result);
  process.stdout.write(`${text}\n`);
  return code;
}
