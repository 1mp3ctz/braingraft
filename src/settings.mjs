import crypto from 'node:crypto';
import { findForeignPaths } from './rewrite.mjs';

export const LOCAL_KEYS = new Set([
  'model', 'theme', 'tui', 'effortLevel', 'voice', 'voiceEnabled', 'statusLine',
  'autoCompactWindow', 'inputNeededNotifEnabled', 'agentPushNotifEnabled',
  'skipDangerousModePermissionPrompt', 'forceLoginMethod', 'autoUpdates',
  'preferredNotifChannel', 'messageIdleNotifThresholdMs', 'apiKeyHelper',
  'awsAuthRefresh', 'awsCredentialExport', 'telemetry'
]);

export const SHARED_KEYS = new Set([
  'hooks', 'permissions', 'disabledSkills', 'enableAllProjectMcpServers',
  'skillListingBudgetFraction', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'outputStyle',
  'alwaysThinkingEnabled', 'spinnerTipsEnabled', 'disabledMcpjsonServers', 'enabledMcpjsonServers'
]);

export const REDACT_KEYS = new Set(['env']);
export const QUARANTINE_KEYS = new Set(['mcpServers', 'enabledPlugins', 'extraKnownMarketplaces']);

const SECRETISH = /(key|token|secret|auth|password|passwd|credential|cookie|session)/i;

export function sanitizeSettings(settings) {
  const shared = {};
  const local = [];
  const unknown = [];
  const redactions = [];
  const envExample = {};
  const quarantined = {};
  const foreign = [];

  for (const [key, value] of Object.entries(settings ?? {})) {
    if (LOCAL_KEYS.has(key)) {
      local.push(key);
      continue;
    }
    if (REDACT_KEYS.has(key)) {
      const [redacted, vars] = redactObject(value, key);
      if (Object.keys(redacted ?? {}).length) shared[key] = redacted;
      redactions.push(...vars.map((v) => `${key}.${v}`));
      for (const v of vars) envExample[envVarName(key, v)] = '';
      continue;
    }
    if (QUARANTINE_KEYS.has(key)) {
      const [redacted, vars] = redactObject(value, key);
      quarantined[key] = redacted;
      redactions.push(...vars.map((v) => `${key}.${v}`));
      for (const v of vars) envExample[envVarName(key, v)] = '';
      foreign.push(...findForeignPaths(JSON.stringify(value ?? {})));
      continue;
    }
    if (SHARED_KEYS.has(key)) {
      shared[key] = value;
      foreign.push(...findForeignPaths(JSON.stringify(value ?? null)));
      continue;
    }
    unknown.push(key);
  }

  return { shared, quarantined, local, unknown, redactions, envExample, foreign: [...new Set(foreign)] };
}

function envVarName(prefix, dotted) {
  return `${prefix}_${dotted}`.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function redactObject(value, path = '') {
  const vars = [];
  const walk = (node, trail) => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${trail}[${i}]`));
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const next = trail ? `${trail}.${k}` : k;
        if (SECRETISH.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          vars.push(next);
          out[k] = `\${${envVarName(path, next)}}`;
          continue;
        }
        if (k === 'env' || k === 'headers') {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const cleaned = {};
            for (const [ek, ev] of Object.entries(v)) {
              if (typeof ev === 'string' && ev.startsWith('${')) {
                cleaned[ek] = ev;
                continue;
              }
              vars.push(`${next}.${ek}`);
              cleaned[ek] = `\${${envVarName(path, `${next}.${ek}`)}}`;
            }
            out[k] = cleaned;
            continue;
          }
        }
        out[k] = walk(v, next);
      }
      return out;
    }
    if (typeof node === 'string' && /:\/\/[^\s/@]+:[^\s/@]+@/.test(node)) {
      vars.push(trail);
      return `\${${envVarName(path, trail)}}`;
    }
    return node;
  };
  return [walk(value, ''), vars];
}

function hookKey(entry) {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16);
}

function mergeHooks(target = {}, incoming = {}) {
  const out = { ...target };
  const report = [];

  for (const [event, groups] of Object.entries(incoming)) {
    if (!Array.isArray(groups)) continue;
    const existing = Array.isArray(out[event]) ? [...out[event]] : [];
    const byMatcher = new Map();
    for (const g of existing) byMatcher.set(String(g?.matcher ?? ''), g);

    for (const group of groups) {
      const matcher = String(group?.matcher ?? '');
      const incomingHooks = Array.isArray(group?.hooks) ? group.hooks : [];
      if (!byMatcher.has(matcher)) {
        byMatcher.set(matcher, { ...group, hooks: [...incomingHooks] });
        report.push({ event, matcher, action: 'added', count: incomingHooks.length });
        continue;
      }
      const merged = byMatcher.get(matcher);
      const seen = new Set((merged.hooks ?? []).map(hookKey));
      let added = 0;
      for (const h of incomingHooks) {
        const key = hookKey(h);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.hooks = [...(merged.hooks ?? []), h];
        added += 1;
      }
      if (added) report.push({ event, matcher, action: 'extended', count: added });
      else report.push({ event, matcher, action: 'identical', count: 0 });
    }

    out[event] = [...byMatcher.values()];
  }

  return { hooks: out, report };
}

function unionArray(a = [], b = []) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
}

export function mergeSettings(target = {}, incoming = {}) {
  const merged = structuredClone(target);
  const report = [];

  for (const [key, value] of Object.entries(incoming)) {
    if (LOCAL_KEYS.has(key)) {
      report.push({ key, action: 'skipped-local' });
      continue;
    }
    if (QUARANTINE_KEYS.has(key)) {
      report.push({ key, action: 'quarantined' });
      continue;
    }

    if (key === 'hooks') {
      const { hooks, report: hookReport } = mergeHooks(target.hooks, value);
      merged.hooks = hooks;
      report.push({ key: 'hooks', action: 'merged', detail: hookReport });
      continue;
    }

    if (key === 'permissions' && value && typeof value === 'object') {
      const t = target.permissions ?? {};
      merged.permissions = {
        ...t,
        ...Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            Array.isArray(v) ? unionArray(t[k], v) : (t[k] ?? v)
          ])
        )
      };
      report.push({ key: 'permissions', action: 'union' });
      continue;
    }

    if (key === 'disabledSkills') {
      merged.disabledSkills = unionArray(target.disabledSkills, value);
      report.push({ key, action: 'union' });
      continue;
    }

    if (SHARED_KEYS.has(key)) {
      if (JSON.stringify(target[key]) === JSON.stringify(value)) {
        report.push({ key, action: 'identical' });
      } else {
        merged[key] = value;
        report.push({ key, action: target[key] === undefined ? 'added' : 'replaced' });
      }
      continue;
    }

    report.push({ key, action: 'ignored-unknown' });
  }

  for (const key of LOCAL_KEYS) {
    if (key in target) merged[key] = target[key];
  }

  return { merged, report };
}

export function localKeysPreserved(before = {}, after = {}) {
  for (const key of LOCAL_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return false;
  }
  return true;
}
