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

function newPlayer(name) {
  return {
    id: randomId(8),
    token: randomId(24),
    name: String(name || '').trim().slice(0, 24) || 'Gast',
    joinedAt: Date.now(),
  };
}

export function createRoom({ filters, items, superLimit, hostName }) {
  const host = newPlayer(hostName);
  const room = {
    id: randomId(10),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    filters,
    superLimit,
    items,
    players: [host],
    votes: { [host.id]: {} },
  };
  rooms.set(room.id, room);
  touch(room);
  return { room, player: host };
}

export function joinRoom(room, name) {
  if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, 'Die Session ist voll.');
  const p = newPlayer(name);
  room.players.push(p);
  room.votes[p.id] = {};
  touch(room);
  return p;
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

export function matches(room) {
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

// Was ein einzelner Mitspieler sieht: eigene Stimmen komplett, von den
// anderen nur den Fortschritt — fremde Stimmen erst, wenn es ein Match ist.
export function viewFor(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  return {
    id: room.id,
    filters: room.filters,
    superLimit: room.superLimit,
    items: room.items,
    hostId: room.players[0].id,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      voted: Object.keys(room.votes[p.id] || {}).length,
    })),
    me: me ? { id: me.id, name: me.name, votes: room.votes[me.id] } : null,
    matches: matches(room),
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
