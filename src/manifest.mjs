import crypto from 'node:crypto';
import { VERSION } from './brand.mjs';
import { sha256 } from './crypto.mjs';

export const MANIFEST_PATH = 'manifest.json';

export function digestOf(manifest) {
  const clone = { ...manifest };
  delete clone.digest;
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

export function buildManifest({ origin, entries, settings, locks, findings, notes }) {
  const manifest = {
    format: 1,
    tool: `claudeport/${VERSION}`,
    created: new Date().toISOString(),
    origin,
    entries,
    settings,
    locks,
    findings,
    notes
  };
  manifest.digest = digestOf(manifest);
  return manifest;
}

export function parseManifest(buf) {
  let manifest;
  try {
    manifest = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('bundle manifest is not valid JSON');
  }
  if (manifest.format !== 1) throw new Error(`unsupported manifest format v${manifest.format}`);
  if (!Array.isArray(manifest.entries)) throw new Error('bundle manifest has no entries');
  return manifest;
}

export function verifyAgainstBytes(manifest, files) {
  const problems = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    const actual = byPath.get(entry.path);
    if (!actual) {
      problems.push({ path: entry.path, reason: 'listed in manifest but absent from archive' });
      continue;
    }
    const hash = sha256(actual.data);
    if (hash !== entry.sha256) {
      problems.push({ path: entry.path, reason: 'content does not match its manifest hash' });
    }
  }

  const manifestPaths = new Set(manifest.entries.map((e) => e.path));
  for (const f of files) {
    if (f.path === MANIFEST_PATH) continue;
    if (!manifestPaths.has(f.path)) {
      problems.push({ path: f.path, reason: 'present in archive but NOT listed in the manifest' });
    }
  }

  const recomputed = digestOf(manifest);
  if (manifest.digest && recomputed !== manifest.digest) {
    problems.push({ path: MANIFEST_PATH, reason: 'manifest digest mismatch' });
  }

  return problems;
}
