export const SECRET = 'secret';
export const BRAIN = 'brain';
export const MEMORY = 'memory';
export const LOCAL = 'local';
export const UNKNOWN = 'unknown';

const SECRET_FILES = [
  /^\.credentials\.json$/i,
  /(^|\/)[^/]*\.credentials\.json$/i,
  /^\.claude\.json(\.backup)?$/i,
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)[^/]*\.pem$/i,
  /(^|\/)[^/]*\.key$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)oauth[^/]*\.json$/i
];

const BRAIN_ROOT_FILES = [
  'CLAUDE.md', 'AGENTS.md', 'settings.json', 'marketplace.json', 'plugin.json',
  'keybindings.json', 'output-styles.json', '.claudeportrc', '.claudeportignore'
];

const BRAIN_DIRS = [
  'agents', 'commands', 'skills', 'rules', 'hooks', 'output-styles',
  'helpers', 'scripts', 'mcp-configs', 'plugins-config', 'styles'
];

const LOCAL_ROOT_FILES = [
  'settings.local.json', 'history.jsonl', 'usage-monitor.json', 'daemon.lock',
  'daemon.status.json', 'daemon.log', 'marketplace-cache.json', 'cost-tracker.log',
  'bash-commands.log', 'mcp-needs-auth-cache.json', 'ruflo-usage-cache.json',
  'stats-cache.json', 'policy-limits.json', 'gh-pr-status-cache.json',
  'mcp-health-cache.json', '.last-cleanup', '.last-update-result.json',
  'installed_plugins.json', 'known_marketplaces.json'
];

const LOCAL_DIRS = [
  'jobs', 'cache', 'backups', 'file-history', 'shell-snapshots', 'sessions',
  'session-data', 'session-env', 'paste-cache', 'image-cache', 'downloads',
  'plugins', 'ide', 'daemon', 'metrics', 'telemetry', 'statsig', 'todos',
  'tasks', 'plans', 'homunculus', '.git', '.claudeport', 'ecc'
];

const MEMORY_RE = /^projects\/([^/]+)\/memory(\/|$)/;

export function isMemoryPath(rel) {
  return MEMORY_RE.test(rel);
}

export function memoryNamespaceOf(rel) {
  const m = rel.match(MEMORY_RE);
  return m ? m[1] : null;
}

export function classify(rel) {
  const first = rel.split('/')[0];
  const base = rel.split('/').pop();

  for (const re of SECRET_FILES) {
    if (re.test(rel) || re.test(base)) return { kind: SECRET, why: 'credential-shaped path' };
  }

  if (isMemoryPath(rel)) return { kind: MEMORY, why: 'auto-memory' };

  if (first === 'projects') return { kind: LOCAL, why: 'session transcripts' };

  if (rel.endsWith('.jsonl')) return { kind: LOCAL, why: 'transcript' };
  if (rel.endsWith('.log')) return { kind: LOCAL, why: 'log' };

  if (LOCAL_ROOT_FILES.includes(rel)) return { kind: LOCAL, why: 'machine-local state' };
  if (LOCAL_DIRS.includes(first)) return { kind: LOCAL, why: 'machine-local runtime' };

  if (BRAIN_ROOT_FILES.includes(rel)) return { kind: BRAIN, why: 'global config' };
  if (BRAIN_DIRS.includes(first)) return { kind: BRAIN, why: `${first}/` };

  return { kind: UNKNOWN, why: 'not in allowlist' };
}

export function isInstructionFile(rel) {
  if (rel === 'CLAUDE.md' || rel === 'AGENTS.md') return true;
  return /^(skills|agents|commands|rules|output-styles)\//.test(rel) && /\.(md|markdown)$/i.test(rel);
}

const EXEC_EXT = /\.(sh|bash|zsh|ps1|bat|cmd|py|rb|pl|mjs|cjs|js)$/i;

export function isExecutable(rel, contents) {
  if (/^(hooks|scripts|helpers)\//.test(rel) && EXEC_EXT.test(rel)) return true;
  if (EXEC_EXT.test(rel)) return true;
  if (contents && contents.length > 2 && contents[0] === 0x23 && contents[1] === 0x21) return true;
  return false;
}
