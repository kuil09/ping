import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import webpush from 'web-push';
const require = createRequire(import.meta.url);
const ece = require('http_ece');
const keys = webpush.generateVAPIDKeys();
const client = createECDH('prime256v1'); client.generateKeys();
const auth = randomBytes(16);
const subscription = { endpoint: 'https://web.push.apple.com/test-fixture-only',
  keys: { p256dh: client.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, name: "push-test", modules: true, scriptPath: resolve('dist-test/push-runtime-worker.js'),
  compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
  bindings: { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: 'mailto:runtime-test@example.com', TEST_SUB: subscription } }));
try {
  const response = await mf.dispatchFetch('https://runtime-test.invalid/');
  const { status, capture, valid, invalid } = await response.json();
  assert.equal(status, 201, 'Native workerd must actually generate the encrypted request');
  assert.equal(valid, true); assert.equal(invalid, false);
  assert.equal(capture.endpoint, subscription.endpoint); assert.equal(capture.redirect, 'error');
  assert.equal(capture.headers['content-encoding'], 'aes128gcm');
  const plain = ece.decrypt(Buffer.from(capture.body), { version: 'aes128gcm', privateKey: client, authSecret: auth });
  assert.deepEqual(JSON.parse(plain.toString()), { type: 'signal', roomId: 'runtime-test' });
  const token = capture.headers.authorization.match(/t=([^,\s]+)/)[1];
  const parts = token.split('.');
  assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).aud, 'https://web.push.apple.com');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  console.log('Native workerd: Web Push encryption decrypted and VAPID signature verified; no external push sent.');
} finally { await mf.dispose(); }
