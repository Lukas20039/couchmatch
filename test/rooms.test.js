import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  authPlayer, castVote, createRoom, joinRoom, loadRooms, matches, pickFinal, resetFinal, startFinal,
  toggleVeto, viewFor,
} from '../lib/rooms.js';
import { filterItems, sanitizeFilters } from '../lib/catalog.js';

await loadRooms(await fs.mkdtemp(path.join(os.tmpdir(), 'couchmatch-')));

const items = ['tt1', 'tt2', 'tt3', 'tt4'].map((id) => ({ id, name: id }));

test('Match nur, wenn alle positiv gestimmt haben', () => {
  const { room, player: a } = createRoom({ filters: {}, items, superLimit: 1, hostName: 'A' });
  castVote(room, a, 'tt1', 'like');
  assert.deepEqual(matches(room), [], 'allein gibt es keine Matches');

  const b = joinRoom(room, 'B');
  castVote(room, a, 'tt2', 'maybe');
  castVote(room, a, 'tt3', 'nope');
  castVote(room, b, 'tt1', 'super');
  castVote(room, b, 'tt2', 'like');
  castVote(room, b, 'tt3', 'like');

  const m = matches(room);
  assert.deepEqual(m.map((x) => x.id), ['tt1', 'tt2']);
  assert.equal(m[0].strong, true);
  assert.equal(m[0].score, 5);
  assert.equal(m[1].strong, false, '"interessant" zählt als vielleicht');
});

test('Super-Like-Limit und Rücknahme', () => {
  const { room, player: a } = createRoom({ filters: {}, items, superLimit: 1, hostName: 'A' });
  castVote(room, a, 'tt1', 'super');
  assert.throws(() => castVote(room, a, 'tt2', 'super'), /Super-Likes/);
  castVote(room, a, 'tt1', null);
  castVote(room, a, 'tt2', 'super');
  assert.equal(room.votes[a.id].tt1, undefined);
});

test('Fremde Stimmen bleiben verborgen, Token wird geprüft', () => {
  const { room, player: a } = createRoom({ filters: {}, items, superLimit: 0, hostName: 'A' });
  const b = joinRoom(room, 'B');
  castVote(room, b, 'tt1', 'nope');
  const v = viewFor(room, a.id);
  assert.deepEqual(v.me.votes, {});
  assert.equal(v.players.find((p) => p.id === b.id).voted, 1);
  assert.ok(!JSON.stringify(v).includes(b.token));
  assert.throws(() => authPlayer(room, b.id, 'falsch'), /Unbekannter/);
});

function roomWithMatches(n, { vetoLimit = 1 } = {}) {
  const list = Array.from({ length: n }, (_, i) => ({ id: `tt${100 + i}`, name: `Film ${i}` }));
  const { room, player: a } = createRoom({ filters: {}, items: list, superLimit: 0, vetoLimit, hostName: 'A' });
  const b = joinRoom(room, 'B');
  // absteigende Scores: die ersten Titel bekommen "super", die späteren "like"
  list.forEach((it, i) => {
    castVote(room, a, it.id, i < n / 2 ? 'super' : 'like');
    castVote(room, b, it.id, 'like');
  });
  return { room, a, b, list };
}

test('Veto streicht Match für alle, ist begrenzt und zurücknehmbar', () => {
  const { room, a, b } = roomWithMatches(3);
  toggleVeto(room, a, 'tt100');
  assert.deepEqual(matches(room).map((m) => m.id), ['tt101', 'tt102']);
  assert.deepEqual(viewFor(room, b.id).vetoes, [{ id: 'tt100', by: a.id }]);
  assert.throws(() => toggleVeto(room, a, 'tt101'), /Kein Veto-Joker/);
  assert.throws(() => toggleVeto(room, b, 'tt100'), /jemand anderes/);
  toggleVeto(room, a, 'tt100'); // zurücknehmen
  assert.equal(matches(room).length, 3);
  assert.throws(() => toggleVeto(room, a, 'tt999'), /Nur Matches/);
});

test('Finale: K.-o. mit Freilos, verborgene Stimmen, Gleichstand nach Score', () => {
  const { room, a, b } = roomWithMatches(5);
  startFinal(room);
  const f = room.final;
  assert.deepEqual(f.entries, ['tt100', 'tt101', 'tt102', 'tt103', 'tt104']);
  // 5 Titel: bester Setzplatz bekommt ein Freilos, dann 2 Duelle
  assert.equal(f.rounds[0].bye, 'tt100');
  assert.deepEqual(f.rounds[0].duels.map((d) => [d.a, d.b]), [['tt101', 'tt104'], ['tt102', 'tt103']]);
  assert.throws(() => toggleVeto(room, a, 'tt100'), /Finale/);

  pickFinal(room, a, 0, 'tt104');
  const seenByB = viewFor(room, b.id).final.rounds[0].duels[0];
  assert.deepEqual(seenByB.picks, {}, 'Wahl von A bleibt vor der Entscheidung verborgen');
  assert.deepEqual(seenByB.picked, [a.id]);
  pickFinal(room, b, 0, 'tt104');
  assert.equal(f.rounds[0].duels[0].winner, 'tt104');
  assert.equal(f.rounds[0].duels[0].decidedBy, 'unanimous');

  // Uneinig: höherer Score gewinnt (tt102 = super+like > tt103 = like+like)
  pickFinal(room, a, 1, 'tt103');
  pickFinal(room, b, 1, 'tt102');
  assert.equal(f.rounds[0].duels[1].winner, 'tt102');
  assert.equal(f.rounds[0].duels[1].decidedBy, 'score');

  // Runde 2: tt100 (Freilos), tt102, tt104 → wieder Freilos für tt100
  assert.equal(f.rounds[1].bye, 'tt100');
  assert.deepEqual(f.rounds[1].duels.map((d) => [d.a, d.b]), [['tt102', 'tt104']]);
  pickFinal(room, a, 0, 'tt104');
  pickFinal(room, b, 0, 'tt104');
  // Runde 3: Endspiel
  assert.deepEqual(f.rounds[2].duels.map((d) => [d.a, d.b]), [['tt100', 'tt104']]);
  pickFinal(room, a, 0, 'tt100');
  pickFinal(room, b, 0, 'tt100');
  assert.equal(f.winner, 'tt100');
  assert.throws(() => pickFinal(room, a, 0, 'tt100'), /kein Finale/);

  resetFinal(room);
  assert.equal(viewFor(room, a.id).final, null);
});

test('Finale braucht mindestens 2 Matches', () => {
  const { room } = roomWithMatches(1);
  assert.throws(() => startFinal(room), /mindestens 2/);
});

test('Filter: Typen, Genres, Ausschlüsse, Kurzfilme, unveröffentlicht', () => {
  const now = Date.parse('2026-10-12');
  const db = [
    { id: 'a', type: 'movie', genres: ['Comedy'], rating: 7, year: 2000, runtime: 100 },
    { id: 'b', type: 'movie', genres: ['Comedy', 'Horror'], rating: 8, year: 2010, runtime: 95 },
    { id: 'c', type: 'series', genres: ['Comedy'], rating: 9, year: 2020 },
    { id: 'd', type: 'movie', genres: ['Comedy'], rating: 8, year: 2010, runtime: 12 },
    { id: 'e', type: 'movie', genres: ['Comedy'], rating: 8, year: 2027, runtime: 100, released: '2027-01-01' },
  ];
  const f = sanitizeFilters({ types: ['movie'], genres: ['Comedy'], excludeGenres: ['Horror'], minRating: 6 });
  assert.deepEqual(filterItems(db, f, now).map((i) => i.id), ['a']);
  const g = sanitizeFilters({ types: ['movie', 'series', 'evil'], minRating: 8.5 });
  assert.deepEqual(filterItems(db, g, now).map((i) => i.id), ['c']);
});

test('Mit Konto tritt man nur einmal bei, roomsOf findet die Session', async () => {
  const { roomsOf } = await import('../lib/rooms.js');
  const { room, player: a } = createRoom({ filters: {}, items, superLimit: 0, hostName: 'A', hostAccountId: 1 });
  const b1 = joinRoom(room, 'B', 2);
  const b2 = joinRoom(room, 'B (Handy)', 2);
  assert.equal(b1.id, b2.id);
  assert.equal(room.players.length, 2);
  assert.equal(joinRoom(room, 'Gast').accountId, null);
  assert.ok(roomsOf(2).some((r) => r.room.id === room.id && r.player.id === b1.id));
  assert.equal(roomsOf(1)[0].player.id, a.id);
});
