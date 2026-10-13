import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as acc from '../lib/accounts.js';
import { createNotifier, decrypt, encrypt, loadVapid, messageFor } from '../lib/push.js';

acc.openDb(':memory:');
const events = [];
acc.onAccountEvent((e) => events.push(e));

const card = (id, name = id) => ({ id, name, poster: 'p', genres: [] });
const mk = (u) => acc.register({ username: u, name: u[0].toUpperCase() + u.slice(1), password: 'geheim123' });
const lukas = await mk('lukas');
const anna = await mk('anna');
const max = await mk('max');
acc.requestFriend(lukas, 'anna');
acc.respondFriend(anna, lukas.id, true);
const listId = acc.pairListId(lukas, anna.id);
const kinds = () => events.map((e) => `${e.kind}→${e.to.join(',')}`);

test('Freundschafts-Ereignisse für Push', () => {
  assert.deepEqual(kinds(), [`friend-request→${anna.id}`, `friend-accepted→${lukas.id}`]);
});

test('Hinzufügen erzeugt Aktivität und Ereignis nur für die andere Person', () => {
  events.length = 0;
  const e1 = acc.addEntry(lukas, listId, card('tt1', 'Alien'), 3);
  acc.addEntry(lukas, listId, card('tt1', 'Alien'), 2); // schon drauf → kein zweites Ereignis
  assert.deepEqual(kinds(), [`add→${anna.id}`]);
  assert.equal(events[0].item.name, 'Alien');
  const feed = acc.activityFeed(anna, listId);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].kind, 'add');
  assert.equal(feed[0].unread, true);
  assert.equal(acc.activityFeed(lukas, listId)[0].unread, false, 'eigene Aktivität ist nie ungelesen');
  assert.equal(acc.myLists(anna)[1].unread, 1);
  acc.markSeen(anna, listId);
  assert.equal(acc.myLists(anna)[1].unread, 0);
  assert.ok(e1);
});

test('Veto: nur einmal, nur selbst zurücknehmen, fliegt aus Session-Titeln', () => {
  events.length = 0;
  const e2 = acc.addEntry(anna, listId, card('tt2', 'Heat'));
  acc.vetoEntry(lukas, e2, true);
  assert.throws(() => acc.vetoEntry(anna, e2, true), /schon ein Veto/);
  assert.throws(() => acc.vetoEntry(anna, e2, false), /jemand anderes/);
  assert.deepEqual(acc.openEntries(anna, listId).map((c) => c.id), ['tt1']);
  const v = acc.listView(anna, listId);
  assert.equal(v.entries.at(-1).vetoedBy, lukas.id, 'Vetos stehen am Ende');
  assert.deepEqual(kinds(), [`add→${lukas.id}`, `veto→${anna.id}`]);
  acc.vetoEntry(lukas, e2, false);
  assert.equal(acc.activityFeed(anna, listId).filter((a) => a.kind === 'veto').length, 0, 'zurückgenommenes Veto verschwindet aus dem Verlauf');
  assert.equal(acc.openEntries(anna, listId).length, 2);
});

test('Kommentare und Reaktionen', () => {
  events.length = 0;
  const entry = acc.listView(lukas, listId).entries.find((e) => e.item.id === 'tt1');
  assert.throws(() => acc.addComment(anna, entry.id, '   '), /leer/);
  const c = acc.addComment(anna, entry.id, 'Unbedingt mit Popcorn 🍿');
  assert.equal(acc.listView(lukas, listId).entries.find((e) => e.id === entry.id).comments, 1);
  assert.equal(acc.activityFeed(lukas, listId, { entryId: entry.id }).filter((a) => a.kind === 'comment')[0].data.text, 'Unbedingt mit Popcorn 🍿');

  assert.equal(acc.react(lukas, c, '😂'), true);
  assert.equal(acc.react(anna, c, '😂'), true);
  assert.throws(() => acc.react(lukas, c, '💩'), /gibt es nicht/);
  assert.throws(() => acc.react(max, c, '😂'), /gibt es nicht/, 'Fremde können nicht reagieren');
  let r = acc.activityFeed(lukas, listId).find((a) => a.id === c).reactions;
  assert.deepEqual(r, [{ emoji: '😂', count: 2, mine: true, names: ['Lukas', 'Anna'] }]);
  assert.equal(acc.react(lukas, c, '😂'), false, 'nochmal tippen nimmt zurück');
  r = acc.activityFeed(lukas, listId).find((a) => a.id === c).reactions;
  assert.deepEqual(r, [{ emoji: '😂', count: 1, mine: false, names: ['Anna'] }]);
  // Nur Lukas' erste Reaktion benachrichtigt Anna; auf eigene Kommentare gibt es keine Nachricht
  assert.deepEqual(kinds(), [`comment→${lukas.id}`, `reaction→${anna.id}`]);

  assert.throws(() => acc.deleteComment(lukas, c), /eigene/);
  acc.deleteComment(anna, c);
  assert.equal(acc.listView(lukas, listId).entries.find((e) => e.id === entry.id).comments, 0);
});

test('Sterne und "gesehen" ersetzen die eigene Aktivität statt zu stapeln', () => {
  const entry = acc.listView(lukas, listId).entries.find((e) => e.item.id === 'tt1');
  acc.setWatched(lukas, entry.id, true);
  acc.rateEntry(anna, entry.id, { stars: 3 });
  acc.rateEntry(anna, entry.id, { stars: 5 });
  const feed = acc.activityFeed(lukas, listId, { entryId: entry.id });
  assert.deepEqual(feed.filter((a) => a.kind === 'stars').map((a) => a.data.stars), [5]);
  acc.setWatched(anna, entry.id, false);
  assert.equal(acc.activityFeed(lukas, listId).filter((a) => a.kind === 'watched').length, 0);
});

test('Admin: ADMIN_USERS oder erstes Konto', () => {
  delete process.env.ADMIN_USERS;
  assert.equal(acc.isAdmin(lukas), true);
  assert.equal(acc.isAdmin(anna), false);
  process.env.ADMIN_USERS = 'Anna, max';
  assert.equal(acc.isAdmin(lukas), false);
  assert.equal(acc.isAdmin(anna), true);
  delete process.env.ADMIN_USERS;
});

test('Statistik zählt Konten, Paare und Einträge', () => {
  const s = acc.stats();
  assert.equal(s.accounts.total, 3);
  assert.equal(s.accounts.solo, 1);
  assert.equal(s.pairs.total, 1);
  assert.equal(s.pairs.withList, 1);
  assert.equal(s.watchlists.entries, 2);
  assert.equal(s.signups.length, 30);
  assert.equal(s.signups.at(-1).n, 3);
  assert.equal(s.topTitles[0].name, 'Alien');
  assert.deepEqual(s.users.map((u) => u.username).sort(), ['anna', 'lukas', 'max']);
});

test('Migration auf eine bestehende Datenbank läuft genau einmal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'couchmatch-db-'));
  acc.closeDb();
  acc.openDb(dir);
  acc.closeDb();
  acc.openDb(dir); // zweites Öffnen darf nichts doppelt anlegen
  acc.closeDb();
  acc.openDb(':memory:');
});

// --- Push ------------------------------------------------------------------

test('Push-Verschlüsselung entspricht dem Beispiel aus RFC 8291', () => {
  const v = {
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    ua: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const out = encrypt('When I grow up, I want to be a watermelon', v.ua, v.auth, {
    salt: Buffer.from(v.salt, 'base64url'),
    senderPrivate: v.asPrivate,
  });
  assert.equal(out.toString('base64url'), v.body);
  assert.equal(decrypt(out, v.uaPrivate, v.auth), 'When I grow up, I want to be a watermelon');
});

test('Benachrichtigungen werden gebündelt und kommen verschlüsselt an', async () => {
  loadVapid(await fs.mkdtemp(path.join(os.tmpdir(), 'couchmatch-vapid-')));
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  const sub = { endpoint: 'https://push.example/abc', p256dh: ua.getPublicKey().toString('base64url'), auth };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return { status: url.endsWith('gone') ? 410 : 201 };
  };
  const dropped = [];
  try {
    const notify = createNotifier({
      subsOf: (id) => (id === 1 ? [sub] : [{ ...sub, endpoint: 'https://push.example/gone' }]),
      dropSub: (e) => dropped.push(e),
      delay: 30,
    });
    const actor = { id: 2, name: 'Anna' };
    for (const name of ['Alien', 'Heat', 'Up']) notify({ to: [1], kind: 'add', actor, listId: 7, item: { name } });
    notify({ to: [3], kind: 'veto', actor, listId: 7, item: { name: 'Heat' } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 2, 'drei Titel → eine Nachricht, plus das Veto');
    const add = sent.find((s) => s.url.endsWith('/abc'));
    assert.match(add.init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    const msg = JSON.parse(decrypt(add.init.body, ua.getPrivateKey().toString('base64url'), auth));
    assert.equal(msg.title, '📌 Anna hat 3 Titel gemerkt');
    assert.equal(msg.body, 'Alien, Heat, Up');
    assert.equal(msg.url, '/w/7');
    assert.deepEqual(dropped, ['https://push.example/gone'], 'abgelaufene Abos werden entfernt');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Texte für alle Ereignisarten', () => {
  const actor = { id: 1, name: 'Lukas' };
  const item = { name: 'Alien' };
  for (const kind of ['add', 'comment', 'veto', 'reaction', 'friend-request', 'friend-accepted', 'invite']) {
    const m = messageFor([{ kind, actor, item, listId: 1, text: 'Hi', emoji: '😂', on: 'comment', roomId: 'R' }]);
    assert.ok(m.title && m.body && m.url.startsWith('/'), kind);
  }
});
