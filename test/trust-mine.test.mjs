import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/pack.mjs';
import { plan, graft } from '../src/graft.mjs';
import { seal } from '../src/container.mjs';
import { load } from '../src/inspect.mjs';
import { pack as tarPack } from '../src/tar.mjs';
import { MANIFEST_PATH } from '../src/manifest.mjs';
import { mergeSettings } from '../src/settings.mjs';
import { STATE_DIR } from '../src/brand.mjs';
import os from 'node:os';
import { makeFixture, cleanup } from './fixture.mjs';

// A destination that is NOT the pack source, so we prove what the BUNDLE adds
// rather than what the target already had.
function freshTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-target-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
  return dir;
}

function bundleWithMcp(fx, { passphrase = null } = {}) {
  fs.writeFileSync(
    path.join(fx.dir, 'settings.json'),
    JSON.stringify({
      model: 'opus',
      alwaysThinkingEnabled: true,
      mcpServers: { notes: { command: `${fx.homeDir}/bin/notes`, env: { NOTES_TOKEN: 'real-token-abc' } } },
      enabledPlugins: { 'acme@market': true }
    })
  );
  const { manifest, files } = build({ dir: fx.dir, h: fx.homeDir, includeMemory: false });
  const tarBuffer = tarPack([
    { path: MANIFEST_PATH, type: 'file', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mode: 0o644 },
    ...files
  ]);
  const file = path.join(fx.root, 'b.brain');
  fs.writeFileSync(file, seal({ tarBuffer, passphrase, manifestDigest: manifest.digest }));
  return file;
}

test('mergeSettings quarantines mcpServers/plugins by default', () => {
  const { merged, report } = mergeSettings({}, {
    mcpServers: { x: { command: 'run' } },
    enabledPlugins: { 'p@m': true }
  });
  assert.equal(merged.mcpServers, undefined);
  assert.equal(merged.enabledPlugins, undefined);
  assert.ok(report.every((r) => !['mcpServers', 'enabledPlugins'].includes(r.key) || r.action === 'quarantined'));
});

test('mergeSettings applies quarantined keys only when explicitly allowed, and merges rather than clobbers', () => {
  const target = { mcpServers: { mine: { command: 'keepme' } } };
  const { merged, report } = mergeSettings(target, {
    mcpServers: { theirs: { command: 'add' } },
    enabledPlugins: { 'p@m': true }
  }, { allowQuarantined: true });
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['mine', 'theirs']);
  assert.deepEqual(merged.enabledPlugins, { 'p@m': true });
  assert.ok(report.some((r) => r.key === 'mcpServers' && r.action === 'applied-trusted'));
});

test('mergeSettings never lets a trusted bundle move machine-local keys', () => {
  const { merged } = mergeSettings({ model: 'sonnet' }, { model: 'opus', mcpServers: { x: {} } }, { allowQuarantined: true });
  assert.equal(merged.model, 'sonnet');
});

test('plan quarantines the mcp lock to pending-mcp.json without trustMine', () => {
  const fx = makeFixture('tm-quarantine');
  const target = freshTarget();
  try {
    const file = bundleWithMcp(fx);
    const bundle = load(file);
    const { ops } = plan({ bundle, dir: target, h: fx.homeDir, trustMine: false });
    const pending = ops.find((o) => o.rel === `${STATE_DIR}/pending-mcp.json`);
    assert.ok(pending, 'mcp lock should land in the pending file');
    const settings = ops.find((o) => o.rel === 'settings.json');
    const merged = JSON.parse(settings.data.toString('utf8'));
    assert.equal(merged.mcpServers, undefined, 'mcpServers must not be enabled');
    assert.equal(merged.enabledPlugins, undefined, 'plugins must not be enabled');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    cleanup(fx);
  }
});

test('plan folds the mcp lock into settings when trustMine is set', () => {
  const fx = makeFixture('tm-apply');
  const target = freshTarget();
  try {
    const file = bundleWithMcp(fx);
    const bundle = load(file);
    const { ops } = plan({ bundle, dir: target, h: fx.homeDir, trustMine: true });
    assert.equal(ops.find((o) => o.rel === `${STATE_DIR}/pending-mcp.json`), undefined, 'nothing left pending');
    const settings = ops.find((o) => o.rel === 'settings.json');
    const merged = JSON.parse(settings.data.toString('utf8'));
    assert.ok(merged.mcpServers.notes, 'server enabled');
    assert.deepEqual(merged.enabledPlugins, { 'acme@market': true });
    assert.equal(merged.model, 'sonnet', 'machine-local model must not move');
    // the secret itself still never travels — only a ${VAR} reference does
    assert.match(merged.mcpServers.notes.env.NOTES_TOKEN, /^\$\{[A-Z_]+\}$/);
    assert.equal(JSON.stringify(merged).includes('real-token-abc'), false);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    cleanup(fx);
  }
});

test('graft refuses --trust-mine on a plaintext bundle (origin is unproven)', async () => {
  const fx = makeFixture('tm-plain');
  const prevHome = process.env.BRAINGRAFT_HOME;
  const prevDir = process.env.BRAINGRAFT_CLAUDE_DIR;
  try {
    const file = bundleWithMcp(fx, { passphrase: null });
    process.env.BRAINGRAFT_HOME = fx.homeDir;
    process.env.BRAINGRAFT_CLAUDE_DIR = fx.dir;
    const code = await graft(file, { apply: true, trustMine: true, yes: true });
    assert.equal(code, 2, 'must refuse rather than enable MCP from an unauthenticated bundle');
  } finally {
    if (prevHome === undefined) delete process.env.BRAINGRAFT_HOME; else process.env.BRAINGRAFT_HOME = prevHome;
    if (prevDir === undefined) delete process.env.BRAINGRAFT_CLAUDE_DIR; else process.env.BRAINGRAFT_CLAUDE_DIR = prevDir;
    cleanup(fx);
  }
});

test('an encrypted bundle only opens with the right passphrase, which is what --trust-mine leans on', () => {
  const fx = makeFixture('tm-enc');
  try {
    const file = bundleWithMcp(fx, { passphrase: 'correct horse battery staple' });
    assert.throws(() => load(file, { passphrase: 'wrong' }), /decryption failed/);
    const bundle = load(file, { passphrase: 'correct horse battery staple' });
    assert.equal(bundle.header.encrypted, true, 'header marks it encrypted -> authenticity proven by the GCM tag');
  } finally {
    cleanup(fx);
  }
});
