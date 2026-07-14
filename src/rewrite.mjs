import { HOME_TOKEN } from './brand.mjs';

const TEXT_EXT = /\.(md|markdown|json|jsonc|sh|bash|zsh|ps1|bat|cmd|py|rb|pl|mjs|cjs|js|ts|tsx|jsx|toml|yaml|yml|txt|css|html|xml|ini|cfg|rc|env\.example)$/i;
const TEXT_BASENAMES = new Set(['CLAUDE.md', 'AGENTS.md', '.claudeportrc', '.claudeportignore', '.gitignore']);

export function isTextPath(rel) {
  const base = rel.split('/').pop();
  return TEXT_EXT.test(rel) || TEXT_BASENAMES.has(base);
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function homeVariants(home) {
  const posix = home.replace(/\\/g, '/').replace(/\/+$/, '');
  const win = posix.replace(/\//g, '\\');
  const winEscaped = posix.replace(/\//g, '\\\\');
  return [...new Set([winEscaped, win, posix])].filter(Boolean);
}

export function tokenizeHome(text, home) {
  let out = text;
  let hits = 0;
  for (const variant of homeVariants(home)) {
    const re = new RegExp(escapeRe(variant), 'gi');
    out = out.replace(re, () => {
      hits += 1;
      return HOME_TOKEN;
    });
  }
  return { text: out, hits };
}

export function detokenizeHome(text, targetHome) {
  const posix = targetHome.replace(/\\/g, '/').replace(/\/+$/, '');
  return text.split(HOME_TOKEN).join(posix);
}

const FOREIGN_ABS = /(?:^|["'\s=:(,])((?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/Volumes\/|\/mnt\/|\/opt\/|\/srv\/)[^\s"',)]{2,})/g;

export function findForeignPaths(text) {
  const out = [];
  let m;
  FOREIGN_ABS.lastIndex = 0;
  while ((m = FOREIGN_ABS.exec(text)) !== null) {
    const p = m[1];
    if (p.includes(HOME_TOKEN)) continue;
    out.push(p);
  }
  return [...new Set(out)];
}

export function normalizeEol(text) {
  const crlf = text.includes('\r\n');
  return { text: crlf ? text.replace(/\r\n/g, '\n') : text, eol: crlf ? 'crlf' : 'lf' };
}

const SHEBANG = 0x23;

export function inferExec(rel, buf) {
  if (buf && buf.length > 1 && buf[0] === SHEBANG && buf[1] === 0x21) return true;
  return /\.(sh|bash|zsh|command|py|rb|pl)$/i.test(rel);
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
