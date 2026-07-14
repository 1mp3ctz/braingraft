import fs from 'node:fs';
import { open } from './container.mjs';
import { LIMITS, unpack, validateEntries } from './tar.mjs';
import { MANIFEST_PATH, parseManifest, verifyAgainstBytes } from './manifest.mjs';
import { isExecutable, isInstructionFile } from './classify.mjs';
import { machineFingerprint, platform, homeNamespace } from './env.mjs';
import { bytes, c, heading, sym, table } from './ui.mjs';

export function load(file, { passphrase = null } = {}) {
  const raw = fs.readFileSync(file);
  const { header, tarBuffer } = open(raw, { passphrase });
  const files = unpack(tarBuffer, LIMITS);

  const pathErrors = validateEntries(files);
  if (pathErrors.length) {
    const detail = pathErrors.slice(0, 8).map((e) => `    ${e.path}: ${e.reason}`).join('\n');
    const err = new Error(`bundle contains unsafe paths and was rejected:\n${detail}`);
    err.code = 'UNSAFE_BUNDLE';
    throw err;
  }

  const manifestFile = files.find((f) => f.path === MANIFEST_PATH);
  if (!manifestFile) throw new Error('bundle has no manifest');
  const manifest = parseManifest(manifestFile.data);

  const contentFiles = files.filter((f) => f.path !== MANIFEST_PATH && f.type === 'file');
  const problems = verifyAgainstBytes(manifest, contentFiles);

  const observed = contentFiles.map((f) => ({
    path: f.path,
    size: f.data.length,
    exec: isExecutable(f.path, f.data),
    instruction: isInstructionFile(f.path) || f.path === 'CLAUDE.md',
    memory: f.path.startsWith('memory/')
  }));

  return { header, manifest, files: contentFiles, observed, problems };
}

export function foreignBundle(manifest) {
  const origin = manifest.origin ?? {};
  return `${origin.os}:${origin.namespace}` !== machineFingerprint();
}

export async function inspect(file, { passphrase = null, json = false } = {}) {
  const { header, manifest, observed, problems } = load(file, { passphrase });

  if (json) {
    process.stdout.write(`${JSON.stringify({ header, origin: manifest.origin, observed, problems }, null, 2)}\n`);
    return problems.length ? 2 : 0;
  }

  const execs = observed.filter((o) => o.exec);
  const instructions = observed.filter((o) => o.instruction);
  const memory = observed.filter((o) => o.memory);
  const mcp = manifest.locks?.mcp ?? [];
  const totalBytes = observed.reduce((a, o) => a + o.size, 0);

  process.stdout.write(`${heading('Bundle')}\n`);
  process.stdout.write(
    table([
      [c.gray('file'), file],
      [c.gray('built by'), manifest.origin?.tool ?? header.tool ?? '?'],
      [c.gray('built on'), `${manifest.origin?.os ?? '?'} ${c.gray(`(namespace ${manifest.origin?.namespace ?? '?'})`)}`],
      [c.gray('created'), header.created ?? manifest.created ?? '?'],
      [c.gray('encrypted'), header.encrypted ? c.green('yes — AES-256-GCM') : c.gray('no')],
      [c.gray('files'), `${observed.length} (${bytes(totalBytes)})`],
      [c.gray('this machine'), `${platform()} ${c.gray(`(namespace ${homeNamespace()})`)}`]
    ]) + '\n'
  );

  process.stdout.write(`${heading('What it wants to install')}\n`);
  process.stdout.write(
    table([
      [instructions.length ? sym.warn : sym.info, c.bold('instruction files'), `${instructions.length}`, c.gray('steer the model on every prompt')],
      [execs.length ? sym.warn : sym.info, c.bold('executable files'), `${execs.length}`, c.gray('hooks/scripts Claude Code runs')],
      [mcp.length ? sym.warn : sym.info, c.bold('MCP servers requested'), `${mcp.length}`, c.gray('quarantined — never auto-enabled')],
      [sym.info, c.bold('memory files'), `${memory.length}`, c.gray('remapped to this machine on graft')]
    ]) + '\n'
  );

  if (execs.length) {
    process.stdout.write(`\n${c.yellow('  Executables in this bundle:')}\n`);
    process.stdout.write(table(execs.slice(0, 20).map((e) => [sym.warn, e.path, c.gray(bytes(e.size))])) + '\n');
  }
  if (mcp.length) {
    process.stdout.write(`\n${c.yellow('  MCP servers it asks for:')} ${mcp.join(', ')}\n`);
    process.stdout.write(c.gray('  These land in .claudeport/pending-mcp.json. Claudeport never writes them into settings.json.\n'));
  }

  if (problems.length) {
    process.stdout.write(`\n${heading('Integrity problems')}\n`);
    for (const p of problems.slice(0, 12)) {
      process.stdout.write(`  ${sym.bad} ${c.red(p.path)} ${c.gray(p.reason)}\n`);
    }
    process.stdout.write(`\n  ${c.red('This bundle does not match its own manifest. Do not graft it.')}\n\n`);
    return 2;
  }

  process.stdout.write(`\n  ${sym.ok} Every file matches its hash, and nothing in the archive is unlisted.\n`);
  if (foreignBundle(manifest)) {
    process.stdout.write(
      `  ${sym.warn} ${c.yellow('This bundle was built on another machine.')} ${c.gray('Grafting runs its hooks and loads its instructions — treat it like unreviewed code.')}\n`
    );
  }
  process.stdout.write('\n');
  return 0;
}
