import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, readHeader, seal } from '../src/container.mjs';
import { pack, unpack } from '../src/tar.mjs';

const tarOf = (text) => pack([{ path: 'CLAUDE.md', type: 'file', data: Buffer.from(text), mode: 0o644 }]);
const PASS = 'correct horse battery staple';

test('unencrypted bundle round-trips', () => {
  const sealed = seal({ tarBuffer: tarOf('hello'), manifestDigest: 'abc' });
  const { header, tarBuffer } = open(sealed);
  assert.equal(header.encrypted, false);
  assert.equal(unpack(tarBuffer)[0].data.toString(), 'hello');
});

test('encrypted bundle round-trips with the right passphrase', () => {
  const sealed = seal({ tarBuffer: tarOf('secret brain'), passphrase: PASS, manifestDigest: 'abc' });
  const { header, tarBuffer } = open(sealed, { passphrase: PASS });
  assert.equal(header.encrypted, true);
  assert.equal(header.kdf.name, 'scrypt');
  assert.equal(Buffer.from(header.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(header.kdf.salt, 'base64').length, 32);
  assert.equal(unpack(tarBuffer)[0].data.toString(), 'secret brain');
});

test('the plaintext never appears in an encrypted bundle', () => {
  const sealed = seal({ tarBuffer: tarOf('MY-SECRET-MEMORY'), passphrase: PASS, manifestDigest: 'abc' });
  assert.equal(sealed.includes(Buffer.from('MY-SECRET-MEMORY')), false);
});

test('two packs of the same content produce different ciphertext (fresh salt and nonce)', () => {
  const a = seal({ tarBuffer: tarOf('same'), passphrase: PASS, manifestDigest: 'abc' });
  const b = seal({ tarBuffer: tarOf('same'), passphrase: PASS, manifestDigest: 'abc' });
  const ha = readHeader(a).header;
  const hb = readHeader(b).header;
  assert.notEqual(ha.nonce, hb.nonce);
  assert.notEqual(ha.kdf.salt, hb.kdf.salt);
  assert.equal(a.equals(b), false);
});

test('a wrong passphrase fails generically', () => {
  const sealed = seal({ tarBuffer: tarOf('x'), passphrase: PASS, manifestDigest: 'abc' });
  assert.throws(
    () => open(sealed, { passphrase: 'wrong passphrase entirely' }),
    (err) => err.code === 'DECRYPT_FAILED' && /decryption failed/.test(err.message)
  );
});

test('tampering with the ciphertext fails with the SAME generic error (no oracle)', () => {
  const sealed = seal({ tarBuffer: tarOf('x'), passphrase: PASS, manifestDigest: 'abc' });
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 30] ^= 0xff;

  let wrongPassMessage;
  let tamperMessage;
  try {
    open(sealed, { passphrase: 'nope nope nope' });
  } catch (err) {
    wrongPassMessage = err.message;
  }
  try {
    open(tampered, { passphrase: PASS });
  } catch (err) {
    tamperMessage = err.message;
  }
  assert.equal(tamperMessage, wrongPassMessage);
});

test('tampering with the AAD-bound header is detected', () => {
  const sealed = seal({ tarBuffer: tarOf('x'), passphrase: PASS, manifestDigest: 'abc' });
  const { headerBuf, bodyOffset } = readHeader(sealed);
  const header = JSON.parse(headerBuf.toString('utf8'));
  header.manifestDigest = 'abd';
  const forgedHeader = Buffer.from(JSON.stringify(header), 'utf8');
  assert.equal(forgedHeader.length, headerBuf.length, 'digest swap must keep the length identical');

  const forged = Buffer.from(sealed);
  forgedHeader.copy(forged, bodyOffset - headerBuf.length);
  assert.throws(() => open(forged, { passphrase: PASS }), (err) => err.code === 'DECRYPT_FAILED');
});

test('an unencrypted bundle whose payload was edited fails its integrity check', () => {
  const sealed = seal({ tarBuffer: tarOf('trustworthy'), manifestDigest: 'abc' });
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 10] ^= 0xff;
  assert.throws(() => open(tampered), /integrity check|incorrect header check|invalid/i);
});

test('refuses a passphrase against an unencrypted bundle (no silent downgrade)', () => {
  const sealed = seal({ tarBuffer: tarOf('x'), manifestDigest: 'abc' });
  assert.throws(() => open(sealed, { passphrase: PASS }), (err) => err.code === 'ENCRYPTION_DOWNGRADE');
});

test('refuses to open an encrypted bundle with no passphrase', () => {
  const sealed = seal({ tarBuffer: tarOf('x'), passphrase: PASS, manifestDigest: 'abc' });
  assert.throws(() => open(sealed), (err) => err.code === 'PASSPHRASE_REQUIRED');
});

test('rejects a file that is not a bundle', () => {
  assert.throws(() => open(Buffer.from('not a bundle at all')), /not a claudeport bundle/);
});
