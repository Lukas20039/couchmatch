import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { authPlayer, castVote, createRoom, joinRoom, loadRooms, matches, viewFor } from '../lib/rooms.js';
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
