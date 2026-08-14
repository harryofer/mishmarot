// Verifies the RFC 8291 encryption + VAPID JWT logic without deploying.
// Encrypts a payload the way the Worker does, then decrypts it as a browser would.
import { webcrypto } from 'node:crypto';
const crypto = webcrypto;
const enc = new TextEncoder(), dec = new TextDecoder();

const b64uToU8 = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const u8ToB64u = u => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const cat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ---- copy of the Worker's encrypt ----
async function encryptPayload(plaintextStr, p256dhB64u, authB64u) {
  const uaPub = b64uToU8(p256dhB64u), authSecret = b64uToU8(authB64u);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = cat(enc.encode(plaintextStr), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// ---- the receiving side (what the browser/push service does) ----
async function decryptRecord(record, uaPrivKey, uaPubRaw, authSecret) {
  const salt = record.slice(0, 16);
  const idlen = record[20];
  const asPub = record.slice(21, 21 + idlen);
  const ct = record.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPubRaw, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ct));
  let end = pt.length; while (end > 0 && pt[end - 1] === 0) end--;
  return dec.decode(pt.slice(0, end - 1)); // strip 0x02 delimiter
}

// ---- VAPID JWT ----
async function vapidAuth(endpoint, pubB64u, privB64u, subject) {
  const aud = new URL(endpoint).origin;
  const seg = o => u8ToB64u(enc.encode(JSON.stringify(o)));
  const unsigned = seg({ typ: 'JWT', alg: 'ES256' }) + '.' +
    seg({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: subject });
  const pub = b64uToU8(pubB64u);
  const jwk = { kty: 'EC', crv: 'P-256', d: privB64u, x: u8ToB64u(pub.slice(1, 33)), y: u8ToB64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return { header: 'vapid t=' + unsigned + '.' + u8ToB64u(sig) + ', k=' + pubB64u, unsigned, sig, pub };
}

// ── run ──
const VAPID_PUBLIC = 'BAz_qeVepTEtRug-tFeIRK95ZXlCnLY7SBQWEF2LjUxUjXhwH2zKkw0mynGkXxGm0jh844Q7v5udSeG1NypPTgc';
const VAPID_PRIVATE = 'YWKh2aQA5vtWI0rzgMRFbT8733XCW_66O4JAQhY5fJk';

// Simulate a browser subscription keypair
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const original = JSON.stringify({ title: 'תזכורת עבודה', body: 'יש לך משמרת מחר', tag: 'before' });
const record = await encryptPayload(original, u8ToB64u(uaPubRaw), u8ToB64u(authSecret));
const roundTrip = await decryptRecord(record, ua.privateKey, uaPubRaw, authSecret);

console.log('1. encrypt→decrypt round trip:', roundTrip === original ? 'PASS ✓' : 'FAIL ✗');
if (roundTrip !== original) { console.log('   expected:', original); console.log('   got     :', roundTrip); }
console.log('   record length:', record.length, 'bytes (salt16+rs4+idlen1+key65+ct)');

// Verify VAPID JWT signature validates against the public key
const v = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', VAPID_PUBLIC, VAPID_PRIVATE, 'mailto:test@example.com');
const verifyKey = await crypto.subtle.importKey('jwk',
  { kty: 'EC', crv: 'P-256', x: u8ToB64u(v.pub.slice(1, 33)), y: u8ToB64u(v.pub.slice(33, 65)), ext: true },
  { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, v.sig, enc.encode(v.unsigned));
console.log('2. VAPID JWT signature verifies:', sigOk ? 'PASS ✓' : 'FAIL ✗');
console.log('   auth header starts:', v.header.slice(0, 40) + '...');
