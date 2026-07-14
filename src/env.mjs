import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function home() {
  return process.env.CLAUDEPORT_HOME
    ? path.resolve(process.env.CLAUDEPORT_HOME)
    : os.homedir();
}

export function claudeDir() {
  if (process.env.CLAUDEPORT_CLAUDE_DIR) return path.resolve(process.env.CLAUDEPORT_CLAUDE_DIR);
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
