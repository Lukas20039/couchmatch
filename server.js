// couchmatch — HTTP-Server ohne Abhängigkeiten.
// API unter /api, Live-Updates per Server-Sent Events, Frontend aus ./public.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, GENRES, MOODS, allItems, catalogStatus, filterItems, loadCatalog, sample,
  sanitizeFilters, syncCatalog, toCard,
} from './lib/catalog.js';
import {
  HttpError, addItems, authPlayer, castVote, createRoom, flushRooms, getRoom, joinRoom, loadRooms,
  pickFinal, resetFinal, startFinal, toggleVeto, viewFor,
} from './lib/rooms.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8095;
const HOST = process.env.HOST || '0.0.0.0';

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

if (process.argv.includes('--sync-only')) {
  await syncCatalog(DATA_DIR, log);
  process.exit(0);
}

await loadRooms(DATA_DIR);
await loadCatalog(DATA_DIR, log);

// --- Live-Updates ---------------------------------------------------------

const streams = new Map(); // roomId -> Set<{res, playerId}>

function broadcast(room) {
  for (const s of streams.get(room.id) || []) {
    s.res.write(`data: ${JSON.stringify(viewFor(room, s.playerId))}\n\n`);
  }
}

setInterval(() => {
  for (const set of streams.values()) for (const s of set) s.res.write(': ping\n\n');
}, 25000).unref();

// --- Helfer ---------------------------------------------------------------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Anfrage zu groß.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ungültiges JSON.');
  }
}

function requireCatalog() {
  if (!catalogStatus().ready) throw new HttpError(503, 'Die Datenbank wird gerade aufgebaut — einen Moment bitte.');
}

const clampCount = (n) => Math.min(200, Math.max(1, Math.round(Number(n) || 50)));

function roomOr404(id) {
  const room = getRoom(id);
  if (!room) throw new HttpError(404, 'Diese Session gibt es nicht (mehr).');
  return room;
}

// --- API ------------------------------------------------------------------

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // ohne "api"
  const method = req.method;

  if (method === 'GET' && parts[0] === 'meta') {
    return send(res, 200, {
      catalog: catalogStatus(),
      genres: GENRES,
      categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
      moods: MOODS,
    });
  }

  if (method === 'POST' && parts[0] === 'preview') {
    requireCatalog();
    const filters = sanitizeFilters((await readBody(req)).filters);
    const list = filterItems(allItems(), filters);
    return send(res, 200, {
      available: list.length,
      movies: list.filter((i) => i.type === 'movie').length,
      series: list.filter((i) => i.type === 'series').length,
      sample: sample(list, 12).map((i) => ({ id: i.id, name: i.name, poster: i.poster })),
    });
  }

  if (method === 'POST' && parts[0] === 'rooms' && parts.length === 1) {
    requireCatalog();
    const body = await readBody(req);
    const filters = sanitizeFilters(body.filters);
    const list = filterItems(allItems(), filters);
    if (!list.length) throw new HttpError(400, 'Mit diesen Filtern gibt es keine Titel.');
    const superLimit = Math.min(50, Math.max(0, Math.round(Number(body.superLimit) || 0)));
    const vetoLimit = Math.min(5, Math.max(0, Math.round(Number(body.vetoLimit) || 0)));
    const { room, player } = createRoom({
      filters,
      superLimit,
      vetoLimit,
      items: sample(list, clampCount(body.count)).map(toCard),
      hostName: body.name,
    });
    log.info(`Session ${room.id} erstellt (${room.items.length} Titel)`);
    return send(res, 201, { roomId: room.id, playerId: player.id, token: player.token });
  }

  if (parts[0] !== 'rooms' || !parts[1]) throw new HttpError(404, 'Nicht gefunden.');
  const room = roomOr404(parts[1]);
  const action = parts[2] || '';

  if (method === 'GET' && action === 'events') {
    const playerId = url.searchParams.get('playerId');
    authPlayer(room, playerId, url.searchParams.get('token'));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const entry = { res, playerId };
    if (!streams.has(room.id)) streams.set(room.id, new Set());
    streams.get(room.id).add(entry);
    res.write(`data: ${JSON.stringify(viewFor(room, playerId))}\n\n`);
    req.on('close', () => {
      const set = streams.get(room.id);
      set?.delete(entry);
      if (set && !set.size) streams.delete(room.id);
    });
    return;
  }

  if (method === 'GET' && action === '') {
    // Öffentliche Kurzinfo für die Einladungsseite
    return send(res, 200, {
      id: room.id,
      host: room.players[0].name,
      players: room.players.map((p) => p.name),
      count: room.items.length,
      filters: room.filters,
    });
  }

  if (method === 'POST' && action === 'join') {
    const body = await readBody(req);
    const p = joinRoom(room, body.name);
    log.info(`Session ${room.id}: ${p.name} beigetreten`);
    broadcast(room);
    return send(res, 201, { playerId: p.id, token: p.token });
  }

  if (method === 'POST' && action === 'vote') {
    const body = await readBody(req);
    const p = authPlayer(room, body.playerId, body.token);
    castVote(room, p, String(body.itemId || ''), body.vote ?? null);
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'veto') {
    const body = await readBody(req);
    const p = authPlayer(room, body.playerId, body.token);
    toggleVeto(room, p, String(body.itemId || ''));
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'final') {
    const body = await readBody(req);
    const p = authPlayer(room, body.playerId, body.token);
    if (body.action === 'start') startFinal(room);
    else if (body.action === 'reset') resetFinal(room);
    else if (body.action === 'pick') pickFinal(room, p, Number(body.duel), String(body.itemId || ''));
    else throw new HttpError(400, 'Unbekannte Aktion.');
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'more') {
    requireCatalog();
    const body = await readBody(req);
    authPlayer(room, body.playerId, body.token);
    const have = new Set(room.items.map((i) => i.id));
    const list = filterItems(allItems(), room.filters).filter((i) => !have.has(i.id));
    if (!list.length) throw new HttpError(409, 'Keine weiteren Titel für diese Filter.');
    const added = sample(list, Math.min(50, clampCount(body.count))).map(toCard);
    addItems(room, added);
    broadcast(room);
    return send(res, 200, { added: added.length });
  }

  throw new HttpError(404, 'Nicht gefunden.');
}

// --- Statische Dateien ----------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.startsWith('/r/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Nicht gefunden.' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Nicht gefunden.' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(res, url.pathname);
    else send(res, 405, { error: 'Methode nicht erlaubt.' });
  } catch (err) {
    if (!(err instanceof HttpError)) log.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Interner Fehler.' });
  }
});

server.listen(PORT, HOST, () => log.info(`couchmatch läuft auf http://${HOST}:${PORT}`));

// Im Container läuft Node als PID 1 und muss SIGTERM selbst behandeln
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log.info(`${sig} empfangen, fahre herunter …`);
    for (const set of streams.values()) for (const s of set) s.res.end();
    server.close();
    await flushRooms().catch((err) => log.error(err));
    process.exit(0);
  });
}
