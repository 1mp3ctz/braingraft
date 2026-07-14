import crypto from 'node:crypto';

export const KDF = { name: 'scrypt', N: 1 << 17, r: 8, p: 1, dkLen: 32 };
const MAXMEM = 256 * 1024 * 1024;
const NONCE_BYTES = 12;
const SALT_BYTES = 32;
const TAG_BYTES = 16;

export class DecryptError extends Error {
  constructor() {
    super('decryption failed (wrong passphrase, corrupted file, or tampered bundle)');
    this.name = 'DecryptError';
    this.code = 'DECRYPT_FAILED';
  }
}

export function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('passphrase required');
  }
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KDF.dkLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: MAXMEM
  });
}

export function newSalt() {
  return crypto.randomBytes(SALT_BYTES);
}

export function newNonce() {
  return crypto.randomBytes(NONCE_BYTES);
}

export function encrypt({ plaintext, key, nonce, aad }) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

export function decrypt({ ciphertext, key, nonce, aad }) {
  if (ciphertext.length < TAG_BYTES) throw new DecryptError();
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptError();
  }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function passphraseWarnings(passphrase) {
  const warnings = [];
  if (passphrase.length < 12) warnings.push('passphrase is shorter than 12 characters');
  if (/^[a-z]+$/i.test(passphrase)) warnings.push('passphrase is letters only');
  if (/^\d+$/.test(passphrase)) warnings.push('passphrase is digits only');
  return warnings;
}
