import zlib from 'node:zlib';
import { MAGIC, FORMAT_VERSION, VERSION } from './brand.mjs';
import { KDF, DecryptError, decrypt, deriveKey, encrypt, newNonce, newSalt, sha256 } from './crypto.mjs';

const HEADER_LEN_BYTES = 4;
const MAX_HEADER = 64 * 1024;
const MAX_PAYLOAD = 512 * 1024 * 1024;
const GZIP_OPTS = { level: 9 };

function aadOf(headerBuf) {
  const lenBuf = Buffer.alloc(HEADER_LEN_BYTES);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), lenBuf, headerBuf]);
}

export function seal({ tarBuffer, passphrase = null, manifestDigest }) {
  const payload = zlib.gzipSync(tarBuffer, GZIP_OPTS);
  if (payload.length > MAX_PAYLOAD) throw new Error('bundle exceeds 512 MB cap');

  const header = {
    format: FORMAT_VERSION,
    tool: `braingraft/${VERSION}`,
    created: new Date().toISOString(),
    manifestDigest,
    encrypted: Boolean(passphrase),
    payloadBytes: payload.length,
    plainBytes: tarBuffer.length
  };

  if (!passphrase) {
    header.payloadSha256 = sha256(payload);
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    return Buffer.concat([aadOf(headerBuf), payload]);
  }

  const salt = newSalt();
  const nonce = newNonce();
  header.kdf = { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') };
  header.nonce = nonce.toString('base64');

  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const aad = aadOf(headerBuf);
  const key = deriveKey(passphrase, salt);
  const ciphertext = encrypt({ plaintext: payload, key, nonce, aad });
  key.fill(0);
  return Buffer.concat([aad, ciphertext]);
}

export function readHeader(buf) {
  if (buf.length < MAGIC.length + 1 + HEADER_LEN_BYTES) throw new Error('not a braingraft bundle');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a braingraft bundle');

  const format = buf[MAGIC.length];
  if (format !== FORMAT_VERSION) throw new Error(`unsupported bundle format v${format}`);

  const lenOffset = MAGIC.length + 1;
  const headerLen = buf.readUInt32BE(lenOffset);
  if (headerLen > MAX_HEADER) throw new Error('bundle header too large');

  const headerStart = lenOffset + HEADER_LEN_BYTES;
  const headerEnd = headerStart + headerLen;
  if (buf.length < headerEnd) throw new Error('truncated bundle header');

  const headerBuf = buf.subarray(headerStart, headerEnd);
  let header;
  try {
    header = JSON.parse(headerBuf.toString('utf8'));
  } catch {
    throw new Error('corrupt bundle header');
  }

  return { header, headerBuf, bodyOffset: headerEnd };
}

export function open(buf, { passphrase = null } = {}) {
  const { header, headerBuf, bodyOffset } = readHeader(buf);
  const body = buf.subarray(bodyOffset);

  if (header.encrypted && !passphrase) {
    const err = new Error('bundle is encrypted: a passphrase is required');
    err.code = 'PASSPHRASE_REQUIRED';
    throw err;
  }
  if (!header.encrypted && passphrase) {
    const err = new Error('bundle is NOT encrypted but a passphrase was supplied — refusing (possible downgrade)');
    err.code = 'ENCRYPTION_DOWNGRADE';
    throw err;
  }

  let payload;
  if (header.encrypted) {
    if (!header.kdf || header.kdf.name !== 'scrypt' || !header.nonce) throw new DecryptError();
    const salt = Buffer.from(header.kdf.salt, 'base64');
    const nonce = Buffer.from(header.nonce, 'base64');
    if (nonce.length !== 12 || salt.length < 16) throw new DecryptError();
    const key = deriveKey(passphrase, salt);
    try {
      payload = decrypt({ ciphertext: body, key, nonce, aad: aadOf(headerBuf) });
    } finally {
      key.fill(0);
    }
  } else {
    payload = body;
    if (header.payloadSha256 && sha256(payload) !== header.payloadSha256) {
      throw new Error('bundle payload failed its integrity check');
    }
  }

  if (payload.length > MAX_PAYLOAD) throw new Error('bundle exceeds 512 MB cap');

  const tarBuffer = zlib.gunzipSync(payload, { maxOutputLength: MAX_PAYLOAD });
  return { header, tarBuffer };
}
