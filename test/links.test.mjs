import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Transaction } from '../src/journal.mjs';
import { walk } from '../src/walk.mjs';
import { makeFixture, cleanup } from './fixture.mjs';

function tryLink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

test('the walker records symlinks without following them', (t) => {
  const fx = makeFixture({ label: 'link-walk' });
  try {
    const outside = path.join(fx.root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'huge-repo-file.md'), 'x'.repeat(1000));

    if (!tryLink(outside, path.join(fx.dir, 'skills', 'linked-skill'), 'junction')) {
      t.skip('this platform/user cannot create links');
      return;
    }

    const { entries } = walk(fx.dir);
    const link = entries.find((e) => e.rel === 'skills/linked-skill');
    assert.ok(link, 'the link must be recorded');
    assert.equal(link.type, 'link');
    assert.equal(
      entries.some((e) => e.rel.includes('huge-repo-file')),
      false,
      'the walker must NOT descend into the link target'
    );
  } finally {
    cleanup(fx.root);
  }
});

test('a linked memory dir is written THROUGH, never replaced', (t) => {
  const fx = makeFixture({ label: 'link-mem' });
  try {
    const real = path.join(fx.dir, 'projects', fx.foreignNs, 'memory');
    const active = path.join(fx.dir, 'projects', 'C--active-ns');
    fs.mkdirSync(active, { recursive: true });

    if (!tryLink(real, path.join(active, 'memory'), 'junction')) {
      t.skip('this platform/user cannot create links');
      return;
    }

    const tx = new Transaction(fx.dir, { test: true });
    tx.add({
      rel: 'projects/C--active-ns/memory/NEW.md',
      action: 'create',
      data: Buffer.from('# written through the link\n')
    });
    tx.commit();

    const throughLink = path.join(real, 'NEW.md');
    assert.ok(fs.existsSync(throughLink), 'the write must land in the REAL directory behind the link');
    assert.equal(fs.readFileSync(throughLink, 'utf8'), '# written through the link\n');

    const linkStat = fs.lstatSync(path.join(active, 'memory'));
    assert.ok(linkStat.isSymbolicLink(), 'the link itself must survive — replacing it forks the brain');
  } finally {
    cleanup(fx.root);
  }
});

test('a link pointing OUTSIDE the Claude dir is refused by default', (t) => {
  const fx = makeFixture({ label: 'link-escape' });
  try {
    const outside = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });

    if (!tryLink(outside, path.join(fx.dir, 'skills', 'external'), 'junction')) {
      t.skip('this platform/user cannot create links');
      return;
    }

    const tx = new Transaction(fx.dir, { test: true });
    tx.add({ rel: 'skills/external/PWNED.md', action: 'create', data: Buffer.from('nope') });
    const journal = tx.commit();

    assert.equal(fs.existsSync(path.join(outside, 'PWNED.md')), false, 'nothing may be written outside the Claude dir');
    assert.equal(journal.ops[0].action, 'refused-external-link');
  } finally {
    cleanup(fx.root);
  }
});

test('an external link IS written when explicitly allowed', (t) => {
  const fx = makeFixture({ label: 'link-allow' });
  try {
    const outside = path.join(fx.root, 'elsewhere2');
    fs.mkdirSync(outside, { recursive: true });

    if (!tryLink(outside, path.join(fx.dir, 'skills', 'external'), 'junction')) {
      t.skip('this platform/user cannot create links');
      return;
    }

    const tx = new Transaction(fx.dir, { test: true });
    tx.add({ rel: 'skills/external/OK.md', action: 'create', data: Buffer.from('yes') });
    tx.commit({ allowExternalLinks: true });

    assert.equal(fs.readFileSync(path.join(outside, 'OK.md'), 'utf8'), 'yes');
  } finally {
    cleanup(fx.root);
  }
});

test("an interrupted graft is detected and can be rolled back", async () => {
  const fx = makeFixture({ label: 'journal-crash' });
  try {
    const tx = new Transaction(fx.dir, { test: true });
    tx.add({ rel: 'skills/new/SKILL.md', action: 'create', data: Buffer.from('new') });
    tx.commit();

    const journalPath = path.join(fx.dir, '.braingraft', 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.status, 'committed');
    assert.equal(journal.ops[0].done, true);

    journal.status = 'committing';
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    const { pendingRecovery } = await import('../src/journal.mjs');
    const stale = pendingRecovery(fx.dir);
    assert.ok(stale, 'an unfinished transaction must be detected on the next run');
    assert.equal(stale.status, 'committing');
  } finally {
    cleanup(fx.root);
  }
});
