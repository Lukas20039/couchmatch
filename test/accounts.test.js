import test from 'node:test';
import assert from 'node:assert/strict';
import * as acc from '../lib/accounts.js';
import { searchItems } from '../lib/catalog.js';

acc.openDb(':memory:');

const card = (id, name = id) => ({ id, name, poster: 'p', genres: [] });
const mk = (u) => acc.register({ username: u, name: u.toUpperCase(), password: 'geheim123' });

const lukas = await mk('lukas');
const anna = await mk('anna');
const max = await mk('max');

test('Registrierung prüft Name und Passwort', async () => {
  await assert.rejects(acc.register({ username: 'Lukas', password: 'geheim123' }), /vergeben/, 'Groß/klein egal');
  await assert.rejects(acc.register({ username: 'ab', password: 'geheim123' }), /3–24/);
  await assert.rejects(acc.register({ username: 'neu', password: 'kurz' }), /8 Zeichen/);
});

test('Anmeldung, Sitzung und Abmeldung', async () => {
  await assert.rejects(acc.login({ username: 'lukas', password: 'falsch!!' }), /stimmt nicht/);
  await assert.rejects(acc.login({ username: 'gibtsnicht', password: 'geheim123' }), /stimmt nicht/);
  const { account, token } = await acc.login({ username: 'LUKAS', password: 'geheim123' });
  assert.equal(account.id, lukas.id);
  assert.equal(acc.sessionAccount(token).username, 'lukas');
  acc.logout(token);
  assert.equal(acc.sessionAccount(token), null);
});

test('Nach 10 Fehlversuchen ist der Benutzername kurz gesperrt', async () => {
  const u = await mk('ziel');
  for (let i = 0; i < 10; i++) await assert.rejects(acc.login({ username: 'ziel', password: 'xxxxxxxx' }));
  await assert.rejects(acc.login({ username: 'ziel', password: 'geheim123' }), /Fehlversuche/);
  assert.ok(u.id);
});

test('Freundschaftsanfrage: annehmen, Gegenanfrage, entfernen', () => {
  assert.throws(() => acc.requestFriend(lukas, 'lukas'), /selbst/);
  assert.throws(() => acc.requestFriend(lukas, 'niemand'), /gibt es nicht/);

  acc.requestFriend(lukas, '@anna');
  assert.throws(() => acc.requestFriend(lukas, 'anna'), /unterwegs/);
  assert.throws(() => acc.respondFriend(lukas, anna.id, true), /Keine offene/, 'eigene Anfrage nicht selbst annehmen');
  assert.deepEqual(acc.social(anna).incoming.map((f) => f.username), ['lukas']);
  assert.deepEqual(acc.social(lukas).outgoing.map((f) => f.username), ['anna']);
  acc.respondFriend(anna, lukas.id, true);
  assert.ok(acc.areFriends(lukas.id, anna.id));
  assert.equal(acc.social(lukas).friends[0].username, 'anna');

  // Fragt die andere Seite parallel an, gilt die zweite Anfrage als Annahme
  acc.requestFriend(max, 'lukas');
  assert.equal(acc.requestFriend(lukas, 'max').status, 'accepted');
  acc.removeFriend(lukas, max.id);
  assert.equal(acc.areFriends(lukas.id, max.id), false);
});

test('Eigene und gemeinsame Watchlist mit Wichtigkeit', () => {
  const lists = acc.myLists(lukas);
  assert.deepEqual(lists.map((l) => l.kind), ['solo', 'pair']);
  const pair = lists[1];
  assert.equal(pair.partner.username, 'anna');
  assert.equal(acc.pairListId(anna, lukas.id), pair.id, 'beide sehen dieselbe Liste');
  assert.throws(() => acc.listView(max, pair.id), /gibt es nicht/, 'Fremde haben keinen Zugriff');

  const e1 = acc.addEntry(lukas, pair.id, card('tt1', 'Alien'), 3);
  const e2 = acc.addEntry(anna, pair.id, card('tt2', 'Heat'), 2);
  assert.equal(acc.addEntry(anna, pair.id, card('tt1'), 3), e1, 'doppelt hinzufügen setzt nur die Wichtigkeit');
  acc.rateEntry(lukas, e2, { priority: 0 });

  const v = acc.listView(anna, pair.id);
  assert.deepEqual(v.entries.map((e) => e.item.name), ['Alien', 'Heat'], 'nach gemeinsamer Wichtigkeit sortiert');
  assert.equal(v.entries[0].score, 6);
  assert.equal(v.entries[0].together, true);
  assert.equal(v.entries[1].together, false);
  assert.equal(acc.myLists(lukas)[1].unrated, 0);
  assert.throws(() => acc.rateEntry(lukas, e1, { priority: 7 }), /Wichtigkeit/);

  acc.setWatched(anna, e1, true);
  acc.rateEntry(lukas, e1, { stars: 5 });
  assert.deepEqual([...acc.watchedIds([lukas.id])], ['tt1']);
  assert.deepEqual(acc.openEntries(lukas, pair.id).map((c) => c.id), ['tt2']);
  assert.equal(acc.listView(lukas, pair.id).entries.find((e) => e.id === e1).ratings[lukas.id].stars, 5);

  acc.removeEntry(anna, e2);
  assert.equal(acc.listView(lukas, pair.id).entries.length, 1);
});

test('Nach dem Entfernen ist die Paar-Liste weg — und nach erneutem Verbinden wieder da', () => {
  const pairId = acc.pairListId(lukas, anna.id);
  acc.removeFriend(anna, lukas.id);
  assert.throws(() => acc.listView(lukas, pairId), /gibt es nicht/);
  assert.equal(acc.myLists(lukas).length, 1);
  acc.requestFriend(lukas, 'anna');
  acc.respondFriend(anna, lukas.id, true);
  assert.equal(acc.listView(lukas, pairId).entries.length, 1);
});

test('Session-Einladungen nur unter Verbundenen', () => {
  assert.throws(() => acc.inviteToRoom(lukas, 'raum1', max.id), /verbundene/);
  acc.inviteToRoom(lukas, 'raum1', anna.id);
  assert.equal(acc.invitesFor(anna)[0].from.username, 'lukas');
  acc.dropInvite('raum1', anna.id);
  assert.equal(acc.invitesFor(anna).length, 0);
});

test('Konto löschen entfernt Freundschaften und Listen', async () => {
  const tmp = await mk('weg');
  acc.requestFriend(tmp, 'anna');
  acc.respondFriend(anna, tmp.id, true);
  acc.addEntry(tmp, acc.pairListId(tmp, anna.id), card('tt9'));
  await assert.rejects(acc.deleteAccount(tmp, { password: 'falsch' }), /stimmt nicht/);
  await acc.deleteAccount(tmp, { password: 'geheim123' });
  assert.equal(acc.social(anna).friends.some((f) => f.username === 'weg'), false);
  assert.equal(acc.myLists(anna).length, 2);
});

test('Titelsuche: Treffer am Anfang vor Treffern mittendrin, Umlaute egal', () => {
  const items = [
    { id: 'tt1', name: 'Die Hard', topRank: 50 },
    { id: 'tt2', name: 'Hard Candy', topRank: 900 },
    { id: 'tt3', name: 'Amélie', topRank: 10 },
    { id: 'tt4', name: 'Richard Jewell', topRank: 1 },
  ];
  assert.deepEqual(searchItems('hard', 10, items).map((i) => i.id), ['tt2', 'tt1', 'tt4']);
  assert.deepEqual(searchItems('amelie', 10, items).map((i) => i.id), ['tt3']);
  assert.deepEqual(searchItems('a', 10, items), [], 'zu kurz');
});
