const crypto = require('node:crypto');

const INFO_BY_TYPE = {
  audio: 'WhatsApp Audio Keys',
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  document: 'WhatsApp Document Keys',
};

function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = Buffer.alloc(0);
  let counter = 1;

  while (Buffer.concat(blocks).length < length) {
    const hmac = crypto.createHmac('sha256', prk);
    hmac.update(previous);
    hmac.update(Buffer.from(info));
    hmac.update(Buffer.from([counter++]));
    previous = hmac.digest();
    blocks.push(previous);
  }

  return Buffer.concat(blocks).subarray(0, length);
}

function deriveMediaKeys(mediaKeyBase64, mediaType) {
  const info = INFO_BY_TYPE[mediaType];

  if (!info) {
    throw new TypeError(`unsupported media type: ${mediaType}`);
  }

  const mediaKey = Buffer.from(mediaKeyBase64, 'base64');

  if (mediaKey.length === 0) {
    throw new TypeError('media key is empty');
  }

  const salt = Buffer.alloc(32, 0);
  const prk = crypto.createHmac('sha256', salt).update(mediaKey).digest();
  const expanded = hkdfExpand(prk, info, 112);

  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
    refKey: expanded.subarray(80, 112),
  };
}

module.exports = {
  deriveMediaKeys,
};
