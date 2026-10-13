// Web-Push ohne Abhängigkeiten: VAPID (RFC 8292) und Verschlüsselung "aes128gcm" (RFC 8291).
// Die VAPID-Schlüssel entstehen beim ersten Start und liegen im Datenverzeichnis.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let vapid = null; // { publicKey: base64url (65 Byte, unkomprimiert), privateJwk }

export function loadVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try {
    vapid = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    vapid = { publicKey: raw.toString('base64url'), privateJwk: jwk };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(vapid), { mode: 0o600 });
  }
  return vapid.publicKey;
}

export const vapidPublicKey = () => vapid?.publicKey || null;

function vapidHeader(endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${sig.toString('base64url')}, k=${vapid.publicKey}`;
}

// Verschlüsselt eine Nachricht für ein Abo (p256dh/auth aus PushSubscription.toJSON().keys).
// salt und senderPrivate nur für Tests gegen die Beispielwerte aus RFC 8291.
export function encrypt(payload, p256dh, auth, { salt = crypto.randomBytes(16), senderPrivate = null } = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (senderPrivate) ecdh.setPrivateKey(Buffer.from(senderPrivate, 'base64url'));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = letzter (und einziger) Datensatz, ohne Auffüllung
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Gegenstück zu encrypt — nur für Tests, der Browser entschlüsselt selbst
export function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate, 'base64url'));
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(shared, Buffer.from(auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = body.subarray(21 + idLen);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

const SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/Lukas20039/couchmatch';

// Liefert den HTTP-Status des Push-Dienstes (201 = angenommen, 404/410 = Abo ungültig)
export async function sendPush(sub, message, { ttl = 24 * 3600 } = {}) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(sub.endpoint, SUBJECT),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'normal',
    },
    body: encrypt(JSON.stringify(message), sub.p256dh, sub.auth),
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

// --- Texte -----------------------------------------------------------------

const PRIO = { 0: '👎 eher nicht', 1: '🙂 gern mal', 2: '😍 will ich', 3: '🔥 unbedingt' };
const q = (s) => `„${s}"`;
const cut = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Ein Ereignis (oder mehrere gleichartige) als Benachrichtigung
export function messageFor(events) {
  const e = events[0];
  const who = e.actor.name;
  const list = `/w/${e.listId}`;
  switch (e.kind) {
    case 'add':
      return events.length === 1
        ? { title: `📌 ${who} hat was gemerkt`, body: `${q(e.item.name)} steht jetzt auf eurer Watchlist${e.priority != null ? ` (${PRIO[e.priority]})` : ''} — wie findest du's?`, url: list, tag: `list-${e.listId}` }
        : { title: `📌 ${who} hat ${events.length} Titel gemerkt`, body: cut(events.map((x) => x.item.name).join(', ')), url: list, tag: `list-${e.listId}` };
    case 'comment':
      return { title: `💬 ${who} zu ${q(e.item.name)}`, body: cut(e.text), url: `${list}?tab=activity` };
    case 'veto':
      return { title: `🚫 Veto von ${who}`, body: `${q(e.item.name)} fliegt aus Zufallstipp und gemeinsamen Sessions.`, url: list };
    case 'reaction':
      return {
        title: `${e.emoji} ${who} hat reagiert`,
        body: e.on === 'comment' ? `auf deinen Kommentar${e.item ? ` zu ${q(e.item.name)}` : ''}` : e.item ? `auf ${q(e.item.name)}` : 'auf deine Aktivität',
        url: `${list}?tab=activity`,
      };
    case 'friend-request':
      return { title: `👤 ${who} möchte sich verbinden`, body: 'Annehmen und gemeinsam eine Watchlist führen.', url: '/konto' };
    case 'friend-accepted':
      return { title: `💞 ${who} hat angenommen`, body: 'Ihr habt jetzt eine gemeinsame Watchlist.', url: '/konto' };
    case 'invite':
      return { title: `🍿 ${who} lädt dich ein`, body: 'Gemeinsam swipen, bis ein Film passt — mach mit!', url: `/r/${e.roomId}` };
    default:
      return null;
  }
}

// Sammelt "hinzugefügt"-Ereignisse kurz, damit 5 gemerkte Matches nur eine Nachricht ergeben
export function createNotifier({ subsOf, dropSub, log = console, delay = 8000 }) {
  const batches = new Map();

  async function deliver(to, message) {
    if (!message) return;
    for (const sub of subsOf(to)) {
      try {
        const status = await sendPush(sub, message);
        if (status === 404 || status === 410) dropSub(sub.endpoint);
        else if (status >= 400) log.warn?.(`Push an Konto ${to}: HTTP ${status}`);
      } catch (err) {
        log.warn?.(`Push an Konto ${to} fehlgeschlagen: ${err.message}`);
      }
    }
  }

  return function onEvent(event) {
    if (!vapid) return;
    for (const to of event.to) {
      if (event.kind !== 'add') {
        deliver(to, messageFor([event]));
        continue;
      }
      const key = `${to}|${event.listId}|${event.actor.id}`;
      const b = batches.get(key);
      if (b) b.events.push(event);
      else {
        const timer = setTimeout(() => {
          batches.delete(key);
          deliver(to, messageFor(batch.events));
        }, delay);
        timer.unref?.();
        const batch = { events: [event], timer };
        batches.set(key, batch);
      }
    }
  };
}
