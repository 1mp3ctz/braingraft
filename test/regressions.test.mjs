import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectDir } from '../src/env.mjs';
import { bundlePathFor, isHomeScopeNamespace, landingPathFor, memoryScopeOf } from '../src/memory.mjs';
import { build, matchGlob } from '../src/pack.mjs';
import { mergeSettings, sanitizeSettings } from '../src/settings.mjs';
import { BLOCK, scanText, summarize } from '../src/scan.mjs';
import { makeFixture, cleanup } from './fixture.mjs';

// --- correctness HIGH #1: dotted / hyphenated usernames ---
test('a dotted username is still home-scope and round-trips', () => {
  const home = 'C:\\Users\\john.smith-doe';
  const ns = encodeProjectDir(home);
  assert.equal(ns, 'C--Users-john-smith-doe');
  assert.ok(isHomeScopeNamespace(ns, home), 'the active dotted-username namespace must be home-scope');
  assert.equal(memoryScopeOf(ns, home), 'home');
  const bp = bundlePathFor(ns, 'MEMORY.md', home);
  assert.equal(bp, 'memory/home/MEMORY.md');
  assert.equal(landingPathFor(bp, '/home/dev'), 'projects/-home-dev/memory/MEMORY.md');
});

test('a foreign home namespace with a dotted username is recognised for rescue', () => {
  const localHome = '/home/dev';
  assert.ok(isHomeScopeNamespace('-Users-jane.q.public', localHome));
  assert.ok(isHomeScopeNamespace('C--Users-first-last', localHome));
});

test('a deep project namespace is NOT treated as home', () => {
  const home = '/home/dev';
  assert.equal(isHomeScopeNamespace('-Users-alice-code-myrepo-src', home), false);
  assert.equal(memoryScopeOf('-Users-alice-code-myrepo-src', home), 'raw');
});

// --- correctness HIGH #2: .claudeportignore glob shapes ---
test('leading-slash and backslash ignore patterns actually match', () => {
  assert.equal(matchGlob('notes.md', '/notes.md'), true);
  assert.equal(matchGlob('skills/foo/bar.md', '/skills/foo'), true);
  assert.equal(matchGlob('hooks/secret.ps1', 'hooks\\secret.ps1'), true);
  assert.equal(matchGlob('memory/private.md', 'memory\\private.md'), true);
  assert.equal(matchGlob('skills/a/b/c.md', 'skills/**'), true);
  assert.equal(matchGlob('other.md', 'notes.md'), false);
});

test('a .claudeportignore rule actually excludes a file from the bundle', () => {
  const fx = makeFixture({ label: 'reg-ignore' });
  try {
    fs.mkdirSync(path.join(fx.dir, 'skills/private'), { recursive: true });
    fs.writeFileSync(path.join(fx.dir, 'skills/private/SKILL.md'), '# secretish\n');
    fs.writeFileSync(path.join(fx.dir, '.claudeportignore'), '/skills/private\n');
    const { manifest } = build({ dir: fx.dir, h: fx.homeDir });
    assert.equal(manifest.entries.some((e) => e.path.includes('skills/private')), false);
  } finally {
    cleanup(fx.root);
  }
});

// --- correctness HIGH #4: nested memory subfolders are packed ---
test('memory files in a subfolder are not silently dropped', () => {
  const fx = makeFixture({ label: 'reg-nested-mem' });
  try {
    const sub = path.join(fx.dir, 'projects', fx.foreignNs, 'memory', 'archive');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'old.md'), '# archived memory\n');

    const { manifest } = build({ dir: fx.dir, h: fx.homeDir });
    const memPaths = manifest.entries.filter((e) => e.kind === 'memory').map((e) => e.path);
    assert.ok(memPaths.some((p) => p.endsWith('archive/old.md')), `nested memory missing from ${JSON.stringify(memPaths)}`);
  } finally {
    cleanup(fx.root);
  }
});

// --- security CRITICAL #1: plugins/marketplaces are quarantined ---
test('enabledPlugins and extraKnownMarketplaces never merge into settings', () => {
  const { merged, report } = mergeSettings(
    {},
    {
      enabledPlugins: { 'attacker/backdoor': true },
      extraKnownMarketplaces: { evil: 'https://github.com/attacker/plugins' }
    }
  );
  assert.equal('enabledPlugins' in merged, false);
  assert.equal('extraKnownMarketplaces' in merged, false);
  assert.ok(report.every((r) => !['enabledPlugins', 'extraKnownMarketplaces'].includes(r.key) || r.action === 'quarantined'));
});

test('plugins are routed to the quarantine object at sanitize time', () => {
  const { shared, quarantined } = sanitizeSettings({
    enabledPlugins: { 'x/y': true },
    extraKnownMarketplaces: { m: 'https://example.com' },
    mcpServers: { s: { command: 'node' } }
  });
  assert.equal('enabledPlugins' in shared, false);
  assert.equal('extraKnownMarketplaces' in shared, false);
  assert.ok('enabledPlugins' in quarantined);
  assert.ok('extraKnownMarketplaces' in quarantined);
  assert.ok('mcpServers' in quarantined);
});

// --- security HIGH: secret scanner blocks named + CLI-arg secrets ---
test('a secret-named assignment with no vendor prefix is BLOCKED', () => {
  const findings = scanText('CLAUDE.md', 'internalServiceToken: "Zx9pLQ7vR2mK8wNcT4hJ6bYfD1sA3eU5"');
  const { blocking } = summarize(findings);
  assert.ok(blocking.length >= 1, 'a named secret must block');
});

test('a secret passed as a CLI argument is BLOCKED', () => {
  const findings = scanText('settings.json', '"args": ["--token", "Zx9pLQ7vR2mK8wNcT4hJ6bYfD1sA3eU5wQ"]');
  const { blocking } = summarize(findings);
  assert.ok(blocking.length >= 1, 'a secret CLI arg must block');
  assert.equal(blocking[0].excerpt.includes('Zx9pLQ7vR2mK8wNcT4hJ6bYfD1sA3eU5wQ'), false);
});

test('an ordinary hash or example value is not falsely blocked', () => {
  const { blocking } = summarize(scanText('README.md', 'sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"'));
  assert.equal(blocking.length, 0);
});
