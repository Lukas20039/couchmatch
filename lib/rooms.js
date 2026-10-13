// Sessions ("Räume"): ein fester Stapel Titel, den alle Mitspieler swipen.
// Gespeichert als JSON-Datei, schreibt verzögert nach jeder Änderung.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const VOTES = { nope: 0, maybe: 1, like: 2, super: 3 };
const MAX_PLAYERS = 6;
const TTL = 30 * 24 * 60 * 60 * 1000;

const rooms = new Map();
let dataFile = null;
let saveTimer = null;

const randomId = (len) => {
  const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
};

export async function loadRooms(dataDir) {
  dataFile = path.join(dataDir, 'rooms.json');
  try {
    const list = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    const cutoff = Date.now() - TTL;
    for (const r of list) if (r.updatedAt > cutoff) rooms.set(r.id, r);
  } catch {
    // erste Ausführung
  }
}

async function save() {
  const tmp = dataFile + '.tmp';
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify([...rooms.values()]));
  await fs.rename(tmp, dataFile);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save().catch((err) => console.error('Sessions speichern fehlgeschlagen:', err.message));
  }, 500);
}

// Beim Herunterfahren noch ausstehende Änderungen schreiben
export async function flushRooms() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await save();
}

export function getRoom(id) {
  return rooms.get(id) || null;
}

function touch(room) {
  room.updatedAt = Date.now();
  scheduleSave();
}

function newPlayer(name, accountId = null) {
  return {
    id: randomId(8),
    token: randomId(24),
    name: String(name || '').trim().slice(0, 24) || 'Gast',
    joinedAt: Date.now(),
    accountId, // gesetzt, wenn jemand angemeldet mitspielt
  };
}

export function createRoom({ filters, items, superLimit, vetoLimit = 0, hostName, hostAccountId = null }) {
  const host = newPlayer(hostName, hostAccountId);
  const room = {
    id: randomId(10),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    filters,
    superLimit,
    vetoLimit,
    items,
    players: [host],
    votes: { [host.id]: {} },
    vetoes: {}, // itemId -> playerId
    final: null,
  };
  rooms.set(room.id, room);
  touch(room);
  return { room, player: host };
}

export function joinRoom(room, name, accountId = null) {
  // Mit Konto tritt man nur einmal bei — ein zweites Gerät übernimmt denselben Platz
  const existing = accountId && room.players.find((p) => p.accountId === accountId);
  if (existing) return existing;
  if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, 'Die Session ist voll.');
  const p = newPlayer(name, accountId);
  room.players.push(p);
  room.votes[p.id] = {};
  touch(room);
  return p;
}

export const allRooms = () => rooms.values();

// Alle (noch nicht abgelaufenen) Sessions, in denen ein Konto mitspielt
export function roomsOf(accountId) {
  const out = [];
  for (const room of rooms.values()) {
    const me = room.players.find((p) => p.accountId === accountId);
    if (me) out.push({ room, player: me });
  }
  return out.sort((a, b) => b.room.updatedAt - a.room.updatedAt);
}

export function authPlayer(room, playerId, token) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p || !token || p.token !== token) throw new HttpError(403, 'Unbekannter Mitspieler.');
  return p;
}

export function castVote(room, player, itemId, vote) {
  if (!room.items.some((i) => i.id === itemId)) throw new HttpError(400, 'Unbekannter Titel.');
  const mine = room.votes[player.id];
  if (vote === null) {
    delete mine[itemId];
  } else {
    if (!(vote in VOTES)) throw new HttpError(400, 'Ungültige Stimme.');
    if (vote === 'super' && room.superLimit && mine[itemId] !== 'super') {
      const used = Object.values(mine).filter((v) => v === 'super').length;
      if (used >= room.superLimit) throw new HttpError(409, 'Keine Super-Likes mehr übrig.');
    }
    mine[itemId] = vote;
  }
  touch(room);
}

export function addItems(room, items) {
  room.items.push(...items);
  touch(room);
}

// Matches ohne die per Veto gestrichenen
export function matches(room) {
  return allMatches(room).filter((m) => !room.vetoes?.[m.id]);
}

function allMatches(room) {
  if (room.players.length < 2) return [];
  const out = [];
  for (const item of room.items) {
    const votes = room.players.map((p) => room.votes[p.id]?.[item.id]);
    if (!votes.every((v) => v && v !== 'nope')) continue;
    out.push({
      id: item.id,
      score: votes.reduce((s, v) => s + VOTES[v], 0),
      // Alle mindestens "Like" → echter Treffer, sonst "vielleicht"
      strong: votes.every((v) => v === 'like' || v === 'super'),
      votes: Object.fromEntries(room.players.map((p, i) => [p.id, votes[i]])),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// --- Veto-Joker -------------------------------------------------------------

// Streicht einen Match für alle; nochmal aufrufen nimmt das eigene Veto zurück.
export function toggleVeto(room, player, itemId) {
  room.vetoes ||= {};
  if (room.final) throw new HttpError(409, 'Während eines Finales gibt es keine Vetos — erst das Finale zurücksetzen.');
  const owner = room.vetoes[itemId];
  if (owner) {
    if (owner !== player.id) throw new HttpError(403, 'Dieses Veto hat jemand anderes eingelegt.');
    delete room.vetoes[itemId];
  } else {
    if (!matches(room).some((m) => m.id === itemId)) throw new HttpError(400, 'Nur Matches können per Veto gestrichen werden.');
    const used = Object.values(room.vetoes).filter((p) => p === player.id).length;
    if (used >= (room.vetoLimit || 0)) throw new HttpError(409, 'Kein Veto-Joker mehr übrig.');
    room.vetoes[itemId] = player.id;
  }
  touch(room);
}

// --- Finale -----------------------------------------------------------------
// K.-o.-Turnier über die Matches: in jedem Duell wählt jede:r einen Titel.
// Mehrheit gewinnt; bei Gleichstand der höhere Match-Score, dann Zufall.

const FINAL_MAX = 8;

export function startFinal(room) {
  const ms = matches(room);
  if (ms.length < 2) throw new HttpError(409, 'Für ein Finale braucht ihr mindestens 2 Matches.');
  const strong = ms.filter((m) => m.strong);
  const pool = (strong.length >= 2 ? strong : ms).slice(0, FINAL_MAX);
  room.final = {
    startedAt: Date.now(),
    entries: pool.map((m) => m.id), // nach Setzplatz sortiert
    scores: Object.fromEntries(pool.map((m) => [m.id, m.score])),
    rounds: [],
    winner: null,
  };
  nextRound(room.final, room.final.entries);
  touch(room);
}

export function resetFinal(room) {
  room.final = null;
  touch(room);
}

function nextRound(final, ids) {
  if (ids.length === 1) {
    final.winner = ids[0];
    return;
  }
  const list = [...ids].sort((a, b) => final.entries.indexOf(a) - final.entries.indexOf(b));
  // Bei ungerader Anzahl kommt der beste Setzplatz kampflos weiter
  const bye = list.length % 2 ? list.shift() : null;
  const duels = [];
  while (list.length) duels.push({ a: list.shift(), b: list.pop(), picks: {}, winner: null, decidedBy: null });
  final.rounds.push({ bye, duels });
}

export function pickFinal(room, player, duelIndex, itemId) {
  const f = room.final;
  if (!f || f.winner) throw new HttpError(409, 'Es läuft gerade kein Finale.');
  const round = f.rounds.at(-1);
  const d = round.duels[duelIndex];
  if (!d) throw new HttpError(400, 'Unbekanntes Duell.');
  if (d.winner) throw new HttpError(409, 'Dieses Duell ist schon entschieden.');
  if (itemId !== d.a && itemId !== d.b) throw new HttpError(400, 'Dieser Titel ist nicht in diesem Duell.');
  d.picks[player.id] = itemId;

  if (room.players.every((p) => d.picks[p.id])) {
    const picks = Object.values(d.picks);
    const forA = picks.filter((v) => v === d.a).length;
    const forB = picks.length - forA;
    if (forA !== forB) {
      d.winner = forA > forB ? d.a : d.b;
      d.decidedBy = picks.every((v) => v === d.winner) ? 'unanimous' : 'majority';
    } else if (f.scores[d.a] !== f.scores[d.b]) {
      d.winner = f.scores[d.a] > f.scores[d.b] ? d.a : d.b;
      d.decidedBy = 'score';
    } else {
      d.winner = Math.random() < 0.5 ? d.a : d.b;
      d.decidedBy = 'random';
    }
  }

  if (round.duels.every((x) => x.winner)) {
    nextRound(f, [...(round.bye ? [round.bye] : []), ...round.duels.map((x) => x.winner)]);
  }
  touch(room);
}

// Fremde Finale-Stimmen bleiben verborgen, bis das Duell entschieden ist
function finalView(f, playerId) {
  if (!f) return null;
  return {
    entries: f.entries,
    winner: f.winner,
    rounds: f.rounds.map((r) => ({
      bye: r.bye,
      duels: r.duels.map((d) => ({
        a: d.a,
        b: d.b,
        winner: d.winner,
        decidedBy: d.decidedBy,
        picked: Object.keys(d.picks),
        picks: d.winner ? d.picks : d.picks[playerId] ? { [playerId]: d.picks[playerId] } : {},
      })),
    })),
  };
}

// Was ein einzelner Mitspieler sieht: eigene Stimmen komplett, von den
// anderen nur den Fortschritt — fremde Stimmen erst, wenn es ein Match ist.
export function viewFor(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  return {
    id: room.id,
    filters: room.filters,
    superLimit: room.superLimit,
    vetoLimit: room.vetoLimit || 0,
    items: room.items,
    hostId: room.players[0].id,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      voted: Object.keys(room.votes[p.id] || {}).length,
    })),
    me: me ? { id: me.id, name: me.name, votes: room.votes[me.id] } : null,
    matches: matches(room),
    vetoes: Object.entries(room.vetoes || {}).map(([id, by]) => ({ id, by })),
    final: finalView(room.final, playerId),
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
