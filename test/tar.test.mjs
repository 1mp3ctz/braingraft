import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { LIMITS, pack, safeJoin, unpack, validateEntries } from '../src/tar.mjs';

test('round-trips files and directories', () => {
  const entries = [
    { path: 'a/b.md', type: 'file', data: Buffer.from('hello'), mode: 0o644 },
    { path: 'a/deep/c.sh', type: 'file', data: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 }
  ];
  const out = unpack(pack(entries));
  assert.equal(out.length, 2);
  assert.equal(out[0].path, 'a/b.md');
  assert.equal(out[0].data.toString(), 'hello');
  assert.equal(out[1].data.toString(), '#!/bin/sh\necho hi\n');
});

test('round-trips a path longer than the 100-byte ustar name field', () => {
  const long = `skills/${'nested-directory/'.repeat(6)}SKILL.md`;
  assert.ok(long.length > 100);
  const out = unpack(pack([{ path: long, type: 'file', data: Buffer.from('x'), mode: 0o644 }]));
  assert.equal(out[0].path, long);
  assert.equal(out[0].data.toString(), 'x');
});

test('round-trips utf-8 content byte-identically', () => {
  const data = Buffer.from('# Über — mémoire · 日本語 ✓\n', 'utf8');
  const out = unpack(pack([{ path: 'memory/MEMORY.md', type: 'file', data, mode: 0o644 }]));
  assert.deepEqual(out[0].data, data);
});

test('detects a corrupted header', () => {
  const buf = pack([{ path: 'a.md', type: 'file', data: Buffer.from('x'), mode: 0o644 }]);
  buf[10] = 0x41;
  assert.throws(() => unpack(buf), /checksum mismatch/);
});

test('rejects an entry larger than the per-entry cap', () => {
  const buf = pack([{ path: 'big.bin', type: 'file', data: Buffer.alloc(1024), mode: 0o644 }]);
  assert.throws(() => unpack(buf, { ...LIMITS, maxEntryBytes: 512 }), /size cap/);
});

test('rejects an archive over the total decompressed cap', () => {
  const buf = pack([
    { path: 'a.bin', type: 'file', data: Buffer.alloc(600), mode: 0o644 },
    { path: 'b.bin', type: 'file', data: Buffer.alloc(600), mode: 0o644 }
  ]);
  assert.throws(() => unpack(buf, { ...LIMITS, maxTotalBytes: 1000 }), /size cap/);
});

test('rejects an archive over the entry-count cap', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    path: `f${i}.md`, type: 'file', data: Buffer.from('x'), mode: 0o644
  }));
  assert.throws(() => unpack(pack(entries), { ...LIMITS, maxEntries: 3 }), /entry count cap/);
});

test('rejects a symlink entry type', () => {
  const buf = pack([{ path: 'ok.md', type: 'file', data: Buffer.from('x'), mode: 0o644 }]);
  buf.write('2', 156, 1, 'latin1');
  let sum = 0;
  const header = buf.subarray(0, 512);
  const copy = Buffer.from(header);
  copy.write('        ', 148, 8, 'utf8');
  for (let i = 0; i < 512; i += 1) sum += copy[i];
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  assert.throws(() => unpack(buf), /disallowed entry type/);
});

test('a gzip bomb is capped, not expanded', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < 20 * 1024);
  assert.throws(
    () => zlib.gunzipSync(bomb, { maxOutputLength: 1024 }),
    (err) => /maxOutputLength|buffer/i.test(err.message)
  );
});

test('validateEntries blocks every unsafe path shape', () => {
  const cases = [
    ['../../etc/passwd', 'parent traversal'],
    ['/etc/passwd', 'absolute path'],
    ['C:/Windows/System32/x', 'absolute path'],
    ['a\\b.md', 'backslash'],
    ['skills/con/x.md', 'Windows-reserved'],
    ['skills/aux.md', 'Windows-reserved'],
    ['skills/x?.md', 'illegal character'],
    ['skills/trailing.', 'illegal character']
  ];
  for (const [path, expect] of cases) {
    const errors = validateEntries([{ path }]);
    assert.equal(errors.length, 1, `expected ${path} to be rejected`);
    assert.match(errors[0].reason, new RegExp(expect, 'i'));
  }
});

test('validateEntries allows ordinary brain paths', () => {
  const ok = [
    'CLAUDE.md',
    'skills/my-skill/SKILL.md',
    'agents/code-reviewer.md',
    'memory/home/MEMORY.md',
    'hooks/observe.sh',
    'rules/common/coding-style.md'
  ];
  assert.deepEqual(validateEntries(ok.map((path) => ({ path }))), []);
});

test('validateEntries catches case collisions that break NTFS/APFS', () => {
  const errors = validateEntries([{ path: 'skills/Foo.md' }, { path: 'skills/foo.md' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /case-collides/);
});

test('safeJoin refuses to escape the destination root', () => {
  assert.throws(() => safeJoin('/tmp/root', '../outside'), /escapes destination root/);
  assert.throws(() => safeJoin('/tmp/root', '/etc/passwd'), /escapes destination root/);
  assert.ok(safeJoin('/tmp/root', 'a/b.md').includes('b.md'));
});
