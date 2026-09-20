const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveMediaKeys,
} = require('../src/whatsapp-media-keys');

const sampleKey = Buffer.alloc(32, 7).toString('base64');

test('derives stable key material', () => {
  const first = deriveMediaKeys(sampleKey, 'audio');
  const second = deriveMediaKeys(sampleKey, 'audio');

  assert.equal(first.iv.length, 16);
  assert.equal(first.cipherKey.length, 32);
  assert.equal(first.macKey.length, 32);
  assert.equal(first.refKey.length, 32);
  assert.deepEqual(first, second);
});

test('media types use different HKDF info strings', () => {
  const audio = deriveMediaKeys(sampleKey, 'audio');
  const image = deriveMediaKeys(sampleKey, 'image');

  assert.notDeepEqual(audio.cipherKey, image.cipherKey);
});

test('rejects unsupported media types', () => {
  assert.throws(
    () => deriveMediaKeys(sampleKey, 'sticker'),
    /unsupported media type/
  );
});
