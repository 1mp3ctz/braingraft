import { lineOf } from './rewrite.mjs';

export const BLOCK = 'block';
export const WARN = 'warn';

export const RULES = [
  { id: 'anthropic-key', level: BLOCK, re: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: 'Anthropic API key' },
  { id: 'openai-key', level: BLOCK, re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, label: 'OpenAI API key' },
  { id: 'github-pat', level: BLOCK, re: /gh[pousr]_[A-Za-z0-9]{30,}/g, label: 'GitHub token' },
  { id: 'github-fine-grained', level: BLOCK, re: /github_pat_[A-Za-z0-9_]{40,}/g, label: 'GitHub fine-grained token' },
  { id: 'aws-key', level: BLOCK, re: /AKIA[0-9A-Z]{16}/g, label: 'AWS access key id' },
  { id: 'slack-token', level: BLOCK, re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: 'Slack token' },
  { id: 'google-key', level: BLOCK, re: /AIza[0-9A-Za-z_-]{35}/g, label: 'Google API key' },
  { id: 'stripe-key', level: BLOCK, re: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g, label: 'Stripe secret key' },
  { id: 'gitlab-token', level: BLOCK, re: /glpat-[A-Za-z0-9_-]{20,}/g, label: 'GitLab token' },
  { id: 'private-key', level: BLOCK, re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, label: 'private key block' },
  { id: 'creds-in-url', level: BLOCK, re: /[a-z][a-z0-9+.-]*:\/\/([^\s/:@"']+):([^\s/@"']+)@[^\s"']+/gi, label: 'credentials embedded in a URL', urlCreds: true },
  { id: 'token-in-url', level: BLOCK, re: /https?:\/\/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})@[^\s"']+/g, label: 'token embedded in a git URL' },
  { id: 'jwt', level: WARN, re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'JWT' },
  { id: 'bearer', level: WARN, re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, label: 'bearer token' }
];

const ASSIGNMENT = /(?:^|[\s,{"'])((?:[A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|token|password|passwd|credential|auth)[A-Za-z0-9_]*))\s*["']?\s*[:=]\s*["']([^"'\n]{20,})["']/gi;
const CLI_FLAG_SECRET = /["']--?(?:api[_-]?key|apikey|secret|token|password|auth|bearer)["']\s*,\s*["']([^"'\n\s]{20,})["']/gi;
const STRONG_SECRET_NAME = /(api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key)/i;

export function entropy(str) {
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function redact(value) {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(6)}…${value.slice(-2)} (${value.length} chars)`;
}

const PLACEHOLDER = /^(\$\{?[A-Z_][A-Z0-9_]*\}?|<[^>]+>|x{4,}|\.{3,}|your[-_]|example|placeholder|dummy|fake|test[-_]?key|sk-ant-api03-XXXX|redacted|changeme|todo)/i;

function isPlaceholder(value) {
  return PLACEHOLDER.test(value.trim()) || /^\*+$/.test(value.trim());
}

const PLACEHOLDER_CRED = /^(user|username|admin|root|pass|passwd|password|pwd|secret|token|example|test|demo|db|dbuser|dbpass|postgres|mysql|redis|myuser|mypassword|changeme|host|localhost|<[^>]+>|\$\{?[A-Za-z_]|your[-_]?)/i;

function isPlaceholderCred(user, pass) {
  if (PLACEHOLDER_CRED.test(user) || PLACEHOLDER_CRED.test(pass)) return true;
  if (pass.includes('${') || pass.includes('<')) return true;
  if (entropy(pass) < 3.0) return true;
  return false;
}

export function scanText(rel, text) {
  const findings = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const value = m[0];
      if (isPlaceholder(value)) continue;
      if (rule.urlCreds && isPlaceholderCred(m[1] ?? '', m[2] ?? '')) continue;
      findings.push({
        file: rel,
        line: lineOf(text, m.index),
        rule: rule.id,
        label: rule.label,
        level: rule.level,
        excerpt: redact(value)
      });
      if (findings.length > 200) return findings;
    }
  }

  ASSIGNMENT.lastIndex = 0;
  let a;
  while ((a = ASSIGNMENT.exec(text)) !== null) {
    const [, key, value] = a;
    if (isPlaceholder(value)) continue;
    if (value.includes('${')) continue;
    if (entropy(value) < 3.0) continue;
    if (/\s/.test(value)) continue;
    const named = STRONG_SECRET_NAME.test(key);
    findings.push({
      file: rel,
      line: lineOf(text, a.index),
      rule: named ? 'named-secret-assignment' : 'high-entropy-assignment',
      label: `${key} = ${named ? 'secret-named value' : 'high-entropy literal'}`,
      level: named ? BLOCK : WARN,
      excerpt: redact(value)
    });
    if (findings.length > 200) break;
  }

  CLI_FLAG_SECRET.lastIndex = 0;
  let f;
  while ((f = CLI_FLAG_SECRET.exec(text)) !== null) {
    const value = f[1];
    if (isPlaceholder(value) || value.includes('${')) continue;
    if (entropy(value) < 3.0) continue;
    findings.push({
      file: rel,
      line: lineOf(text, f.index),
      rule: 'secret-cli-argument',
      label: 'secret passed as a command-line argument',
      level: BLOCK,
      excerpt: redact(value)
    });
    if (findings.length > 200) break;
  }

  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}:${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarize(findings) {
  return {
    blocking: findings.filter((f) => f.level === BLOCK),
    warnings: findings.filter((f) => f.level === WARN)
  };
}
