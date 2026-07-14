import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectDir, home } from './env.mjs';
import { dirSize } from './walk.mjs';

const HOME_SCOPE_RE = /^(?:[A-Za-z]-)?-(?:Users|home|root)-[^-]+(?:-[^-]+)?$/;

export function isHomeScopeNamespace(ns) {
  return HOME_SCOPE_RE.test(ns);
}

export function guessOsOf(ns) {
  if (/^[A-Za-z]--/.test(ns)) return 'windows';
  if (/^-Users-/.test(ns)) return 'macOS';
  if (/^-home-|^-root/.test(ns)) return 'linux';
  return 'unknown';
}

export function guessPathOf(ns) {
  if (/^([A-Za-z])--(.*)$/.test(ns)) {
    const [, drive, rest] = ns.match(/^([A-Za-z])--(.*)$/);
    return `${drive}:\\${rest.replace(/-/g, '\\')}`;
  }
  return `/${ns.replace(/^-/, '').replace(/-/g, '/')}`;
}

export function activeNamespace(h = home()) {
  return encodeProjectDir(h);
}

export function listNamespaces(claudeDir, h = home()) {
  const projectsDir = path.join(claudeDir, 'projects');
  const active = activeNamespace(h);
  let names = [];
  try {
    names = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const ns of names) {
    const dir = path.join(projectsDir, ns);
    const memDir = path.join(dir, 'memory');
    let st;
    try {
      st = fs.lstatSync(memDir);
    } catch {
      continue;
    }

    const isLink = st.isSymbolicLink();
    let realTarget = null;
    let readable = true;
    try {
      realTarget = fs.realpathSync(memDir);
    } catch {
      readable = false;
    }

    const { bytes, files } = readable ? dirSize(memDir) : { bytes: 0, files: 0 };
    if (files === 0 && !isLink) continue;

    out.push({
      ns,
      dir: memDir,
      isLink,
      realTarget,
      readable,
      files,
      bytes,
      isActive: ns === active,
      homeScope: isHomeScopeNamespace(ns),
      os: guessOsOf(ns),
      guessedPath: guessPathOf(ns)
    });
  }
  return out;
}

export function diagnose(claudeDir, h = home()) {
  const namespaces = listNamespaces(claudeDir, h);
  const active = activeNamespace(h);
  const activeEntry = namespaces.find((n) => n.ns === active) ?? null;
  const activeReal = activeEntry?.realTarget ? path.resolve(activeEntry.realTarget) : null;

  const invisible = namespaces.filter((n) => {
    if (n.isActive) return false;
    if (n.files === 0) return false;
    if (activeReal && n.realTarget && path.resolve(n.realTarget) === activeReal) return false;
    return true;
  });

  return {
    active,
    activeExists: Boolean(activeEntry),
    activeFiles: activeEntry?.files ?? 0,
    activeBytes: activeEntry?.bytes ?? 0,
    activeIsLink: activeEntry?.isLink ?? false,
    namespaces,
    invisible,
    invisibleBytes: invisible.reduce((a, n) => a + n.bytes, 0),
    invisibleFiles: invisible.reduce((a, n) => a + n.files, 0)
  };
}

export function memoryScopeOf(ns) {
  return isHomeScopeNamespace(ns) ? 'home' : 'raw';
}

export function bundlePathFor(ns, rel) {
  return memoryScopeOf(ns) === 'home' ? `memory/home/${rel}` : `memory/raw/${ns}/${rel}`;
}

export function landingPathFor(bundlePath, h = home()) {
  if (bundlePath.startsWith('memory/home/')) {
    const rel = bundlePath.slice('memory/home/'.length);
    return `projects/${activeNamespace(h)}/memory/${rel}`;
  }
  if (bundlePath.startsWith('memory/raw/')) {
    const rest = bundlePath.slice('memory/raw/'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    const ns = rest.slice(0, slash);
    const rel = rest.slice(slash + 1);
    return `projects/${ns}/memory/${rel}`;
  }
  return null;
}
