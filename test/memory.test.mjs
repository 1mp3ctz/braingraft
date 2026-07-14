import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectDir } from '../src/env.mjs';
import { bundlePathFor, diagnose, guessOsOf, isHomeScopeNamespace, landingPathFor, memoryScopeOf } from '../src/memory.mjs';
import { makeFixture, cleanup } from './fixture.mjs';

test('encodes home paths exactly the way Claude Code names its project dirs', () => {
  assert.equal(encodeProjectDir('/Users/alice'), '-Users-alice');
  assert.equal(encodeProjectDir('C:\\Users\\bob'), 'C--Users-bob');
  assert.equal(encodeProjectDir('/home/dev'), '-home-dev');
  assert.equal(encodeProjectDir('/root'), '-root');
});

test('recognises a home-scope namespace on every platform', () => {
  assert.ok(isHomeScopeNamespace('-Users-alice'));
  assert.ok(isHomeScopeNamespace('C--Users-bob'));
  assert.ok(isHomeScopeNamespace('-home-dev'));
  assert.equal(isHomeScopeNamespace('-Users-alice-code-my-repo'), false);
});

test('guesses the origin OS from the namespace', () => {
  assert.equal(guessOsOf('C--Users-bob'), 'windows');
  assert.equal(guessOsOf('-Users-alice'), 'macOS');
  assert.equal(guessOsOf('-home-dev'), 'linux');
});

test('home-scope memory from ANY machine lands in THIS machine\'s namespace', () => {
  const cases = [
    ['/Users/alice', '-Users-alice'],
    ['C:\\Users\\bob', 'C--Users-bob'],
    ['/home/dev', '-home-dev']
  ];
  for (const [sourceHome, sourceNs] of cases) {
    assert.equal(memoryScopeOf(sourceNs), 'home');
    const bundlePath = bundlePathFor(sourceNs, 'MEMORY.md');
    assert.equal(bundlePath, 'memory/home/MEMORY.md');

    for (const [targetHome, targetNs] of cases) {
      const landed = landingPathFor(bundlePath, targetHome);
      assert.equal(
        landed,
        `projects/${targetNs}/memory/MEMORY.md`,
        `${sourceHome} → ${targetHome} must land in ${targetNs}`
      );
    }
  }
});

test('project-scoped memory is preserved verbatim, not remapped into home', () => {
  const ns = '-Users-alice-code-some-repo';
  assert.equal(memoryScopeOf(ns), 'raw');
  const bundlePath = bundlePathFor(ns, 'notes.md');
  assert.equal(bundlePath, `memory/raw/${ns}/notes.md`);
  assert.equal(landingPathFor(bundlePath, '/home/dev'), `projects/${ns}/memory/notes.md`);
});

test('diagnose flags memory that Claude cannot see on this machine', () => {
  const fx = makeFixture({ label: 'diag' });
  try {
    const result = diagnose(fx.dir, fx.homeDir);
    assert.equal(result.invisible.length, 1);
    assert.equal(result.invisible[0].ns, fx.foreignNs);
    assert.equal(result.invisibleFiles, 2);
    assert.ok(result.invisibleBytes > 0);
    assert.equal(result.activeExists, false);
  } finally {
    cleanup(fx.root);
  }
});

test('diagnose reports zero invisible memory once it is in the active namespace', () => {
  const fx = makeFixture({ label: 'diag-ok' });
  try {
    const active = path.join(fx.dir, 'projects', encodeProjectDir(fx.homeDir), 'memory');
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'MEMORY.md'), '# mine\n');
    fs.rmSync(path.join(fx.dir, 'projects', fx.foreignNs), { recursive: true, force: true });

    const result = diagnose(fx.dir, fx.homeDir);
    assert.equal(result.invisible.length, 0);
    assert.equal(result.activeExists, true);
    assert.equal(result.activeFiles, 1);
  } finally {
    cleanup(fx.root);
  }
});
