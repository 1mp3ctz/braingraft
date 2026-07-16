#!/usr/bin/env node
import process from 'node:process';
import { DISPLAY, TAGLINE, VERSION } from '../src/brand.mjs';
import { doctor } from '../src/doctor.mjs';
import { pack } from '../src/pack.mjs';
import { inspect } from '../src/inspect.mjs';
import { graft } from '../src/graft.mjs';
import { pull, push } from '../src/sync.mjs';
import { undo } from '../src/journal.mjs';
import { claudeDir } from '../src/env.mjs';
import { askPassphrase, c, sym } from '../src/ui.mjs';

const HELP = `
${DISPLAY} ${c.gray(`v${VERSION}`)} — ${TAGLINE}

${c.bold('COMMANDS')}
  doctor                     Diagnose this machine. Read-only. Start here.
  pack [-o file]             Pack your brain into a portable bundle.
  inspect <file>             Show exactly what a bundle would do. Read-only.
  graft <file> [--apply]     Install a bundle here. Dry run unless --apply.
  undo                       Roll back the last graft.
  sync push|pull             Git-backed sync with a PRIVATE repo.

${c.bold('FLAGS')}
  --json                     Machine-readable output.
  -o, --out <file>           Bundle path for pack.
  --encrypt                  Encrypt the bundle (AES-256-GCM, passphrase).
  --no-memory                Pack config only — leave memory files behind.
  --apply                    Actually write (graft/sync pull).
  --theirs                   On conflict, take the bundle's version.
  --trust                    Acknowledge that a foreign bundle runs code here.
  --trust-mine               Your own bundle: also enable its MCP servers/plugins.
                             Requires an encrypted bundle (proves it is yours).
  --yes                      Skip confirmation prompts.
  --remote <git-url>         Remote for sync.
  --allow-unverified-remote  Push to a non-GitHub remote you swear is private.
  --allow-external-links     Write through symlinks that leave your Claude dir.

${c.bold('EXAMPLES')}
  ${c.gray('$')} npx braingraft doctor
  ${c.gray('$')} npx braingraft pack --encrypt -o brain.brain
  ${c.gray('$')} npx braingraft inspect brain.brain
  ${c.gray('$')} npx braingraft graft brain.brain --apply

Claude directory: ${c.gray(claudeDir())}
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-o' || a === '--out') {
      args.flags.out = argv[++i];
    } else if (a === '--remote') {
      args.flags.remote = argv[++i];
    } else if (a.startsWith('--')) {
      args.flags[a.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = true;
    } else if (a === '-h') {
      args.flags.help = true;
    } else if (a === '-v') {
      args.flags.version = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const { _: positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || flags.help || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : 1;
  }

  const json = Boolean(flags.json);
  const yes = Boolean(flags.yes);

  switch (command) {
    case 'doctor':
      return doctor({ json });

    case 'pack': {
      const passphrase = flags.encrypt ? await askPassphrase('Passphrase for the bundle: ') : null;
      if (flags.encrypt && !passphrase) {
        process.stderr.write(`${sym.bad} a passphrase is required with --encrypt\n`);
        return 1;
      }
      if (passphrase) {
        const { passphraseWarnings } = await import('../src/crypto.mjs');
        for (const w of passphraseWarnings(passphrase)) {
          process.stderr.write(`${sym.warn} ${c.yellow(`weak passphrase: ${w}`)}\n`);
        }
      }
      return pack({
        out: flags.out,
        encrypt: Boolean(flags.encrypt),
        passphrase,
        includeMemory: flags.memory !== false && !flags.noMemory,
        yes,
        json
      });
    }

    case 'inspect': {
      const file = positional[1];
      if (!file) {
        process.stderr.write(`${sym.bad} usage: braingraft inspect <file>\n`);
        return 1;
      }
      return inspect(file, { passphrase: await maybePassphrase(file), json });
    }

    case 'graft': {
      const file = positional[1];
      if (!file) {
        process.stderr.write(`${sym.bad} usage: braingraft graft <file> [--apply]\n`);
        return 1;
      }
      return graft(file, {
        apply: Boolean(flags.apply),
        preferTheirs: Boolean(flags.theirs),
        trust: Boolean(flags.trust),
        trustMine: Boolean(flags.trustMine),
        allowExternalLinks: Boolean(flags.allowExternalLinks),
        passphrase: await maybePassphrase(file),
        yes,
        json
      });
    }

    case 'undo': {
      try {
        const result = undo(claudeDir());
        process.stdout.write(
          `\n  ${sym.ok} Rolled back ${result.restored.length + result.removed.length} file(s) ${c.gray(`(transaction ${result.id})`)}\n` +
          `    ${c.gray(`${result.restored.length} restored, ${result.removed.length} removed`)}\n`
        );
        if (result.failed.length) {
          process.stdout.write(`  ${sym.warn} ${result.failed.length} could not be rolled back:\n`);
          for (const f of result.failed) process.stdout.write(`    ${f.rel}: ${f.error}\n`);
          return 2;
        }
        process.stdout.write('\n');
        return 0;
      } catch (err) {
        process.stderr.write(`${sym.bad} ${err.message}\n`);
        return 1;
      }
    }

    case 'sync': {
      const sub = positional[1];
      if (sub === 'push') {
        return push({
          remote: flags.remote,
          yes,
          allowUnverifiedRemote: Boolean(flags.allowUnverifiedRemote)
        });
      }
      if (sub === 'pull') {
        return pull({
          remote: flags.remote,
          apply: Boolean(flags.apply),
          preferTheirs: Boolean(flags.theirs),
          trust: Boolean(flags.trust),
          yes
        });
      }
      process.stderr.write(`${sym.bad} usage: braingraft sync push|pull [--remote <git-url>]\n`);
      return 1;
    }

    default:
      process.stderr.write(`${sym.bad} unknown command: ${command}\n${HELP}\n`);
      return 1;
  }
}

async function maybePassphrase(file) {
  const { readHeader } = await import('../src/container.mjs');
  const fs = await import('node:fs');
  try {
    const buf = fs.readFileSync(file);
    const { header } = readHeader(buf);
    if (!header.encrypted) return null;
  } catch {
    return null;
  }
  return askPassphrase('Passphrase: ');
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    process.stderr.write(`${sym.bad} ${c.red(err.message)}\n`);
    if (process.env.CLAUDEPORT_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
