// Cloudflare Worker — Web Push server for מעקב משמרות
// Free tier: Workers + KV + Cron Triggers.
//
// Secrets required (wrangler secret put ...):
//   VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (e.g. mailto:you@example.com)
// KV binding required: SUBS

const TZ = 'Asia/Jerusalem';
const enc = new TextEncoder();

// ── small helpers ────────────────────────────────────────────
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
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ── RFC 8291 payload encryption (aes128gcm) ──────────────────
async function encryptPayload(plaintextStr, p256dhB64u, authB64u) {
  const uaPub = b64uToU8(p256dhB64u);
  const authSecret = b64uToU8(authB64u);

  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey)); // 65 bytes
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const keyInfo = cat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1]));
  const ikm = await hmac(prkKey, keyInfo);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const padded = cat(enc.encode(plaintextStr), new Uint8Array([2])); // 0x02 = last-record delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// ── VAPID JWT (ES256) ────────────────────────────────────────
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const seg = o => u8ToB64u(enc.encode(JSON.stringify(o)));
  const unsigned = seg({ typ: 'JWT', alg: 'ES256' }) + '.' +
    seg({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' });

  const pub = b64uToU8(env.VAPID_PUBLIC);
  const jwk = {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE,
    x: u8ToB64u(pub.slice(1, 33)), y: u8ToB64u(pub.slice(33, 65)), ext: true
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)));
  return 'vapid t=' + unsigned + '.' + u8ToB64u(sig) + ', k=' + env.VAPID_PUBLIC;
}

async function sendPush(sub, message, env) {
  const body = await encryptPayload(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidAuth(sub.endpoint, env),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400'
    },
    body
  });
  return res.status;
}

// ── time helpers (in the user's timezone) ────────────────────
export function nowParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, day: +p.day };
}
const shiftDate = (base, n) => {
  const d = new Date(base + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── decide which reminders are due right now ─────────────────
export function dueMessages(rec, t) {
  const n = rec.reminders || {};
  const sent = rec.sent || {};
  const dates = new Set(rec.shiftDates || []);
  const out = [];
  const due = time => t.hm >= (time || '00:00');
  const whenTxt = k => k === 0 ? 'היום' : k === 1 ? 'מחר' : 'בעוד ' + k + ' ימים';

  if (n.before !== false && due(n.beforeTime || '20:00') && sent.before !== t.date) {
    const k = n.beforeDays == null ? 1 : n.beforeDays;
    if (dates.has(shiftDate(t.date, k)))
      out.push(['before', { title: 'תזכורת עבודה', body: 'יש לך משמרת ' + whenTxt(k), tag: 'before' }]);
  }
  if (n.before2 && due(n.before2Time || '20:00') && sent.before2 !== t.date) {
    const k = n.before2Days == null ? 2 : n.before2Days;
    if (dates.has(shiftDate(t.date, k)))
      out.push(['before2', { title: 'תזכורת עבודה', body: 'יש לך משמרת ' + whenTxt(k), tag: 'before2' }]);
  }
  if (n.paid !== false && due(n.paidTime || '12:00') && sent.paid !== t.date) {
    if (t.day === (n.paidDay == null ? 10 : n.paidDay))
      out.push(['paid', { title: 'תזכורת תשלום', body: 'בדוק אילו משמרות שולמו וסמן אותן', tag: 'paid' }]);
  }
  if (n.worked !== false && due(n.workedTime || '18:00') && sent.worked !== t.date) {
    if (dates.has(t.date))
      out.push(['worked', { title: 'אישור הגעה', body: 'הגעת היום לעבודה? הקש לסימון', tag: 'worked' }]);
  }
  return out;
}

// ── HTTP API ─────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/key') return json({ key: env.VAPID_PUBLIC });

    if (url.pathname === '/subscribe' && req.method === 'POST') {
      const b = await req.json();
      if (!b.sub || !b.sub.endpoint) return json({ error: 'missing subscription' }, 400);
      const id = u8ToB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b.sub.endpoint)))).slice(0, 32);
      const prev = await env.SUBS.get(id, 'json');
      await env.SUBS.put(id, JSON.stringify({
        sub: b.sub,
        reminders: b.reminders || {},
        shiftDates: b.shiftDates || [],
        sent: (prev && prev.sent) || {}
      }));
      return json({ ok: true, id });
    }

    if (url.pathname === '/unsubscribe' && req.method === 'POST') {
      const b = await req.json();
      if (b.endpoint) {
        const id = u8ToB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b.endpoint)))).slice(0, 32);
        await env.SUBS.delete(id);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/test' && req.method === 'POST') {
      const b = await req.json();
      const id = u8ToB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b.endpoint)))).slice(0, 32);
      const rec = await env.SUBS.get(id, 'json');
      if (!rec) return json({ error: 'not subscribed' }, 404);
      const st = await sendPush(rec.sub, { title: 'בדיקת התראה', body: 'ההתראות עובדות! 🎉', tag: 'test' }, env);
      return json({ ok: st >= 200 && st < 300, status: st });
    }

    return json({ ok: true, service: 'mishmarot-push' });
  },

  // Cron trigger — checks every 15 minutes and sends what is due
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const t = nowParts();
      let cursor;
      do {
        const list = await env.SUBS.list({ cursor });
        cursor = list.list_complete ? null : list.cursor;
        for (const k of list.keys) {
          const rec = await env.SUBS.get(k.name, 'json');
          if (!rec) continue;
          const msgs = dueMessages(rec, t);
          if (!msgs.length) continue;
          let changed = false;
          for (const [key, msg] of msgs) {
            const st = await sendPush(rec.sub, msg, env);
            if (st === 404 || st === 410) { await env.SUBS.delete(k.name); changed = false; break; }
            if (st >= 200 && st < 300) { rec.sent = rec.sent || {}; rec.sent[key] = t.date; changed = true; }
          }
          if (changed) await env.SUBS.put(k.name, JSON.stringify(rec));
        }
      } while (cursor);
    })());
  }
};
