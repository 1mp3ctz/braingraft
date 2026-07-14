import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, scanText, summarize } from '../src/scan.mjs';
import { classify } from '../src/classify.mjs';
import { detokenizeHome, findForeignPaths, normalizeEol, tokenizeHome } from '../src/rewrite.mjs';
import { HOME_TOKEN } from '../src/brand.mjs';

const KEYS = [
  ['anthropic', 'sk-ant-api03-aaaaaaaaaaaaaaaaaa' + 'aaaaaaaaaaaaaaaaaa'],
  ['openai', 'sk-proj-aaaaaaaaaaaaaaaaaaaa' + 'aaaaaaaaaaaaaaaaaaaa'],
  ['github', 'ghp_aaaaaaaaaaaaaaaaaa' + 'aaaaaaaaaaaaaaaaaa'],
  ['aws', 'AKIAIOSFODNN7EXAMPLE'],
  ['slack', 'xoxb-12345' + '67890-abcdefghijkl'],
  ['google', 'AIzaSyA123' + '4567890abcdefghijklmnopqrstuv'],
  ['stripe', 'sk_live_abcdefghij' + 'klmnopqrstuvwx'],
  ['gitlab', 'glpat-abcdefghij' + 'klmnopqrst']
];

for (const [name, key] of KEYS) {
  test(`blocks a ${name} key wherever it appears`, () => {
    const findings = scanText('skills/x/SKILL.md', `Use ${key} to authenticate.\n`);
    const { blocking } = summarize(findings);
    assert.ok(blocking.length >= 1, `${name} key was not caught`);
    assert.equal(blocking[0].level, BLOCK);
    assert.equal(blocking[0].excerpt.includes(key), false, 'the finding must not echo the secret');
  });
}

test('blocks a private key block', () => {
  const findings = scanText('hooks/deploy.sh', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
  assert.equal(summarize(findings).blocking.length, 1);
});

test('blocks credentials embedded in a git URL', () => {
  const findings = scanText('settings.json', '{"repo":"https://ghp_aaaaaaaaaaaaaaaaaa' + 'aaaaaaaaaaaaaaaaaa@github.com/me/x.git"}');
  assert.ok(summarize(findings).blocking.length >= 1);
});

test('blocks a password embedded in any URL', () => {
  const findings = scanText('mcp.json', 'postgres://admin:sup3rs3cret@db.example.com:5432/app');
  assert.ok(summarize(findings).blocking.length >= 1);
});

test('does not flag placeholders, examples, or env-var references', () => {
  const text = [
    'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}',
    'api_key: <your-key-here>',
    'token = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"',
    'password: changeme',
    'export KEY=$MY_KEY'
  ].join('\n');
  const { blocking, warnings } = summarize(scanText('README.md', text));
  assert.equal(blocking.length, 0);
  assert.equal(warnings.length, 0);
});

test('does not flag ordinary prose or code', () => {
  const text = '# Skill\n\nThis skill reviews code. It uses no secrets.\n\n```js\nconst x = compute(a, b);\n```\n';
  assert.deepEqual(scanText('skills/x/SKILL.md', text), []);
});

test('secrets are never echoed in full in a finding', () => {
  const secret = 'sk-ant-api03-zzzzzzzzzzzzzzzzzz' + 'zzzzzzzzzzzzzzzzzz';
  for (const f of scanText('x.md', secret)) {
    assert.equal(f.excerpt.includes(secret), false);
  }
});

test('credentials are classified as secret and can never be packed', () => {
  assert.equal(classify('.credentials.json').kind, 'secret');
  assert.equal(classify('.claude.json').kind, 'secret');
  assert.equal(classify('hooks/.env').kind, 'secret');
  assert.equal(classify('id_rsa').kind, 'secret');
});

test('transcripts and runtime junk are classified local, never packed', () => {
  assert.equal(classify('history.jsonl').kind, 'local');
  assert.equal(classify('projects/-Users-x/sessions/a.jsonl').kind, 'local');
  assert.equal(classify('jobs/x/state.json').kind, 'local');
  assert.equal(classify('settings.local.json').kind, 'local');
  assert.equal(classify('plugins/repos/x/index.js').kind, 'local');
});

test('the brain is classified brain, and memory is classified memory', () => {
  assert.equal(classify('CLAUDE.md').kind, 'brain');
  assert.equal(classify('skills/x/SKILL.md').kind, 'brain');
  assert.equal(classify('agents/r.md').kind, 'brain');
  assert.equal(classify('hooks/observe.sh').kind, 'brain');
  assert.equal(classify('projects/-Users-x/memory/MEMORY.md').kind, 'memory');
});

test('home paths round-trip through the portable token', () => {
  const home = 'C:\\Users\\bob';
  const original = 'node C:\\Users\\bob\\.claude\\helpers\\statusline.cjs and C:/Users/bob/bin';
  const { text, hits } = tokenizeHome(original, home);
  assert.ok(hits >= 2);
  assert.equal(text.includes('bob'), false);
  assert.ok(text.includes(HOME_TOKEN));

  const landed = detokenizeHome(text, '/Users/alice');
  assert.ok(landed.includes('/Users/alice/.claude/helpers/statusline.cjs'.replace(/\//g, '\\')) || landed.includes('/Users/alice'));
  assert.equal(landed.includes(HOME_TOKEN), false);
});

test('a JSON-escaped Windows home path is tokenized too', () => {
  const home = 'C:\\Users\\bob';
  const json = '{"command":"C:\\\\Users\\\\bob\\\\bin\\\\node"}';
  const { text } = tokenizeHome(json, home);
  assert.equal(text.includes('bob'), false);
});

test('detokenizing produces forward slashes that work on every platform', () => {
  const landed = detokenizeHome(`${HOME_TOKEN}/.claude/x.cjs`, 'C:\\Users\\bob');
  assert.equal(landed, 'C:/Users/bob/.claude/x.cjs');
});

test('foreign absolute paths are reported, never silently rewritten', () => {
  const found = findForeignPaths('command: /Volumes/External/somebot/venv/bin/python');
  assert.deepEqual(found, ['/Volumes/External/somebot/venv/bin/python']);
  assert.deepEqual(findForeignPaths(`${HOME_TOKEN}/bin/python`), []);
});

test('CRLF is normalized so a Windows-packed shell script still runs on macOS', () => {
  const { text, eol } = normalizeEol('#!/bin/bash\r\necho hi\r\n');
  assert.equal(eol, 'crlf');
  assert.equal(text.includes('\r'), false);
});
