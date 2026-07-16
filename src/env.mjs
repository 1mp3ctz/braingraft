import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function home() {
  const override = process.env.BRAINGRAFT_HOME ?? process.env.CLAUDEPORT_HOME;
  return override ? path.resolve(override) : os.homedir();
}

export function claudeDir() {
  const override = process.env.BRAINGRAFT_CLAUDE_DIR ?? process.env.CLAUDEPORT_CLAUDE_DIR;
  if (override) return path.resolve(override);
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(home(), '.claude');
}

export function platform() {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

export function encodeProjectDir(absPath) {
  return absPath.replace(/[\\/:.]/g, '-');
}

export function homeNamespace(h = home()) {
  return encodeProjectDir(h);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function homeAsPosix(h = home()) {
  return h.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function machineFingerprint() {
  return `${platform()}:${homeNamespace()}`;
}
