import path from 'node:path';

const BLOCK = 512;
const T_FILE = '0';
const T_DIR = '5';
const T_LONGNAME = 'L';

export const LIMITS = {
  maxEntries: 20000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024
};

function padOctal(value, len) {
  const s = value.toString(8);
  return s.padStart(len - 1, '0').slice(-(len - 1)) + '\0';
}

function writeString(buf, str, offset, len) {
  const b = Buffer.from(str, 'utf8');
  if (b.length > len) throw new Error(`field overflow at ${offset}`);
  b.copy(buf, offset);
}

function header({ name, size = 0, mode = 0o644, mtime = 0, type = T_FILE }) {
  const buf = Buffer.alloc(BLOCK, 0);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error('name too long for ustar header');
  writeString(buf, name, 0, 100);
  writeString(buf, padOctal(mode & 0o7777, 8), 100, 8);
  writeString(buf, padOctal(0, 8), 108, 8);
  writeString(buf, padOctal(0, 8), 116, 8);
  writeString(buf, padOctal(size, 12), 124, 12);
  writeString(buf, padOctal(Math.floor(mtime / 1000), 12), 136, 12);
  buf.write('        ', 148, 8, 'utf8');
  buf.write(type, 156, 1, 'utf8');
  buf.write('ustar\0', 257, 6, 'latin1');
  buf.write('00', 263, 2, 'latin1');

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += buf[i];
  const checksum = `${sum.toString(8).padStart(6, '0').slice(-6)}\0 `;
  buf.write(checksum, 148, 8, 'latin1');
  return buf;
}

function padTo512(len) {
  const rem = len % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

export function pack(entries) {
  const chunks = [];
  for (const e of entries) {
    const name = e.type === T_DIR || e.type === 'dir' ? `${e.path.replace(/\/+$/, '')}/` : e.path;
    const type = e.type === 'dir' ? T_DIR : T_FILE;
    const data = type === T_FILE ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0);

    if (Buffer.byteLength(name, 'utf8') > 100) {
      const nameBytes = Buffer.from(name, 'utf8');
      chunks.push(header({ name: '././@LongLink', size: nameBytes.length + 1, mode: 0o644, type: T_LONGNAME }));
      const payload = Buffer.concat([nameBytes, Buffer.from([0])]);
      chunks.push(payload, Buffer.alloc(padTo512(payload.length), 0));
      chunks.push(header({ name: nameBytes.subarray(0, 100).toString('utf8'), size: data.length, mode: e.mode ?? 0o644, mtime: e.mtime ?? 0, type }));
    } else {
      chunks.push(header({ name, size: data.length, mode: e.mode ?? (type === T_DIR ? 0o755 : 0o644), mtime: e.mtime ?? 0, type }));
    }

    if (data.length) {
      chunks.push(data, Buffer.alloc(padTo512(data.length), 0));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

function readString(buf, offset, len) {
  const slice = buf.subarray(offset, offset + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
}

function readOctal(buf, offset, len) {
  const s = readString(buf, offset, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

export function unpack(buf, limits = LIMITS) {
  const entries = [];
  let offset = 0;
  let total = 0;
  let pendingLongName = null;

  while (offset + BLOCK <= buf.length) {
    const head = buf.subarray(offset, offset + BLOCK);
    if (head.every((b) => b === 0)) break;

    const magic = head.subarray(257, 262).toString('latin1');
    if (magic !== 'ustar') throw new Error('corrupt archive: bad ustar magic');

    const stored = readString(head, 148, 8).trim();
    const check = Buffer.from(head);
    check.write('        ', 148, 8, 'utf8');
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += check[i];
    if (parseInt(stored, 8) !== sum) throw new Error('corrupt archive: checksum mismatch');

    const type = readString(head, 156, 1) || T_FILE;
    const size = readOctal(head, 124, 12);
    const mode = readOctal(head, 100, 8);
    let name = readString(head, 0, 100);
    const prefix = readString(head, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    offset += BLOCK;

    if (size > limits.maxEntryBytes) throw new Error(`archive entry exceeds size cap: ${name}`);
    const data = buf.subarray(offset, offset + size);
    offset += size + padTo512(size);

    if (type === T_LONGNAME) {
      pendingLongName = data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)).toString('utf8');
      continue;
    }

    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = null;
    }

    if (type !== T_FILE && type !== T_DIR && type !== '\0') {
      throw new Error(`archive contains a disallowed entry type (${type}) at ${name}`);
    }

    total += size;
    if (total > limits.maxTotalBytes) throw new Error('archive exceeds decompressed size cap');
    if (entries.length >= limits.maxEntries) throw new Error('archive exceeds entry count cap');

    entries.push({
      path: name.replace(/\/+$/, ''),
      type: type === T_DIR ? 'dir' : 'file',
      mode,
      data: type === T_DIR ? null : Buffer.from(data)
    });
  }

  return entries;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const WIN_ILLEGAL = /[<>:"|?*]/;
const hasControlChar = (s) => {
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) < 32) return true;
  return false;
};

export function validateEntries(entries) {
  const errors = [];
  const seen = new Map();

  for (const e of entries) {
    const p = e.path;

    if (!p || p === '.') {
      errors.push({ path: p, reason: 'empty path' });
      continue;
    }
    if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p)) {
      errors.push({ path: p, reason: 'absolute path' });
      continue;
    }
    if (p.includes('\\')) {
      errors.push({ path: p, reason: 'backslash in archive path' });
      continue;
    }
    const segments = p.split('/');
    if (segments.some((s) => s === '..')) {
      errors.push({ path: p, reason: 'parent traversal' });
      continue;
    }
    if (segments.some((s) => WIN_RESERVED.test(s))) {
      errors.push({ path: p, reason: 'Windows-reserved name' });
      continue;
    }
    if (segments.some((s) => WIN_ILLEGAL.test(s) || hasControlChar(s) || /[ .]$/.test(s))) {
      errors.push({ path: p, reason: 'illegal character or trailing dot/space (unwritable on Windows)' });
      continue;
    }

    const key = p.toLowerCase();
    if (seen.has(key) && seen.get(key) !== p) {
      errors.push({ path: p, reason: `case-collides with ${seen.get(key)}` });
      continue;
    }
    seen.set(key, p);
  }

  return errors;
}

export function safeJoin(root, rel) {
  const target = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (target !== rootResolved && !target.startsWith(withSep)) {
    throw new Error(`path escapes destination root: ${rel}`);
  }
  return target;
}
