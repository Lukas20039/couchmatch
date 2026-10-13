// Konten, Freundschaften und Watchlists — SQLite-Datei im Datenverzeichnis
// (node:sqlite, keine Abhängigkeiten, kein zweiter Container).
//
// Eine Watchlist gehört entweder einem Konto allein oder einem Konto-Paar
// (zwei befreundete Konten). Jedes Mitglied bewertet jeden Eintrag mit
// einer Wichtigkeit, nach dem Schauen zusätzlich mit Sternen.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './rooms.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 180 * 24 * 60 * 60 * 1000;
export const PRIORITIES = { 0: '👎 Eher nicht', 1: '🙂 Gern mal', 2: '😍 Will ich', 3: '🔥 Unbedingt' };
const UNRATED = 1; // ohne Bewertung zählt ein Eintrag wie "gern mal"

let db = null;

export function openDb(dataDir) {
  const file = dataDir === ':memory:' ? dataDir : path.join(dataDir, 'couchmatch.db');
  if (file !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    -- a_id < b_id, damit es pro Paar genau eine Zeile gibt
    CREATE TABLE IF NOT EXISTS friendships (
      a_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      b_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      PRIMARY KEY (a_id, b_id)
    );
    -- owner_b NULL = eigene Liste, sonst Paar-Liste (owner_a < owner_b)
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY,
      owner_a INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      owner_b INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lists_owners ON lists (owner_a, IFNULL(owner_b, 0));
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      card TEXT NOT NULL,
      added_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      added_at INTEGER NOT NULL,
      watched_at INTEGER,
      UNIQUE (list_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS ratings (
      entry_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      priority INTEGER CHECK (priority BETWEEN 0 AND 3),
      stars INTEGER CHECK (stars BETWEEN 1 AND 5),
      PRIMARY KEY (entry_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS invites (
      room_id TEXT NOT NULL,
      from_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, to_id)
    );
  `);
  migrate();
  db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(Date.now() - SESSION_TTL);
  return db;
}

// Schema-Änderungen nach der ersten Version, nummeriert über PRAGMA user_version
function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 2) {
    db.exec(`
      BEGIN;
      ALTER TABLE watchlist ADD COLUMN vetoed_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
      -- Verlauf einer Liste: hinzugefügt, kommentiert, Veto, gesehen, Sterne
      CREATE TABLE activities (
        id INTEGER PRIMARY KEY,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        entry_id INTEGER REFERENCES watchlist(id) ON DELETE CASCADE,
        actor_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX activities_list ON activities (list_id, id);
      CREATE INDEX activities_entry ON activities (entry_id, kind);
      CREATE TABLE reactions (
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (activity_id, account_id, emoji)
      );
      -- Bis zu welcher Aktivität jemand eine Liste gelesen hat
      CREATE TABLE list_seen (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        seen_id INTEGER NOT NULL,
        PRIMARY KEY (account_id, list_id)
      );
      CREATE TABLE push_subs (
        endpoint TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
}

export function closeDb() {
  db?.close();
  db = null;
}

const one = (sql, ...a) => db.prepare(sql).get(...a) ?? null;
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- Benachrichtigungen ----------------------------------------------------
// Der Server hängt sich hier an und schickt betroffenen Konten ein Live-Update.

const listeners = new Set();
export const onAccountChange = (fn) => listeners.add(fn);
function notify(...ids) {
  const set = new Set(ids.filter(Boolean));
  for (const fn of listeners) fn(set);
}

// Ereignisse für Push-Benachrichtigungen: { to: [accountId], kind, actor, ... }
const eventListeners = new Set();
export const onAccountEvent = (fn) => eventListeners.add(fn);
function emit(event) {
  if (!event.to.length) return;
  for (const fn of eventListeners) fn(event);
}

// --- Konten & Anmeldung ----------------------------------------------------

const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,23}$/i;
const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);

export const publicAccount = (a) => a && { id: a.id, username: a.username, name: a.name };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}

// Gleiche Laufzeit für unbekannte Benutzernamen, damit sich nicht erraten lässt, welche es gibt
const DUMMY_HASH = await hashPassword(crypto.randomUUID());

function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Das Passwort braucht mindestens 8 Zeichen.');
  if (pw.length > 200) throw new HttpError(400, 'Das Passwort ist zu lang.');
}

export async function register({ username, name, password }) {
  username = String(username ?? '').trim();
  if (!USERNAME.test(username)) {
    throw new HttpError(400, 'Benutzername: 3–24 Zeichen, nur Buchstaben, Ziffern, Punkt, Minus und Unterstrich.');
  }
  validPassword(password);
  if (one('SELECT 1 FROM accounts WHERE username = ?', username)) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
  const pwHash = await hashPassword(password);
  try {
    const r = run('INSERT INTO accounts (username, name, pw_hash, created_at) VALUES (?, ?, ?, ?)',
      username, cleanName(name) || username, pwHash, Date.now());
    return getAccount(Number(r.lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
    throw err;
  }
}

// Bremse gegen Passwort-Raten: nach 10 Fehlversuchen 15 Minuten Pause pro Benutzername
const failures = new Map();
const LOCK_AFTER = 10;
const LOCK_FOR = 15 * 60 * 1000;

export async function login({ username, password }) {
  const key = String(username ?? '').trim().toLowerCase();
  const f = failures.get(key);
  if (f && f.count >= LOCK_AFTER && Date.now() - f.last < LOCK_FOR) {
    throw new HttpError(429, 'Zu viele Fehlversuche — bitte in 15 Minuten nochmal.');
  }
  const acc = one('SELECT * FROM accounts WHERE username = ?', key);
  const ok = await checkPassword(String(password ?? ''), acc?.pw_hash || DUMMY_HASH);
  if (!acc || !ok) {
    const prev = f && Date.now() - f.last < LOCK_FOR ? f.count : 0;
    failures.set(key, { count: prev + 1, last: Date.now() });
    throw new HttpError(401, 'Benutzername oder Passwort stimmt nicht.');
  }
  failures.delete(key);
  return { account: publicAccount(acc), token: createSession(acc.id) };
}

export function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run('INSERT INTO sessions (token_hash, account_id, created_at, last_seen) VALUES (?, ?, ?, ?)', sha(token), accountId, now, now);
  return token;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function sessionAccount(token) {
  if (!token) return null;
  const s = one('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
  if (!s) return null;
  const now = Date.now();
  if (now - s.last_seen > SESSION_TTL) {
    run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    return null;
  }
  // Nur grob nachführen, nicht bei jedem Request schreiben
  if (now - s.last_seen > 60 * 60 * 1000) run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now, s.token_hash);
  return getAccount(s.account_id);
}

export function logout(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
}

export function getAccount(id) {
  return publicAccount(one('SELECT * FROM accounts WHERE id = ?', id));
}

export function updateProfile(me, { name }) {
  const n = cleanName(name);
  if (!n) throw new HttpError(400, 'Der Anzeigename darf nicht leer sein.');
  run('UPDATE accounts SET name = ? WHERE id = ?', n, me.id);
  notify(me.id, ...friendIds(me.id));
  return getAccount(me.id);
}

export async function changePassword(me, { current, next }) {
  const acc = one('SELECT * FROM accounts WHERE id = ?', me.id);
  if (!(await checkPassword(String(current ?? ''), acc.pw_hash))) throw new HttpError(403, 'Das aktuelle Passwort stimmt nicht.');
  validPassword(next);
  run('UPDATE accounts SET pw_hash = ? WHERE id = ?', await hashPassword(next), me.id);
  // Alle anderen Geräte abmelden
  run('DELETE FROM sessions WHERE account_id = ?', me.id);
  return createSession(me.id);
}

export async function deleteAccount(me, { password }) {
  const acc = one('SELECT * FROM accounts WHERE id = ?', me.id);
  if (!(await checkPassword(String(password ?? ''), acc.pw_hash))) throw new HttpError(403, 'Das Passwort stimmt nicht.');
  const friends = friendIds(me.id);
  run('DELETE FROM accounts WHERE id = ?', me.id); // alles andere hängt per ON DELETE CASCADE dran
  notify(...friends);
}

// --- Freundschaften --------------------------------------------------------

const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);

function friendship(x, y) {
  return one('SELECT * FROM friendships WHERE a_id = ? AND b_id = ?', ...pairKey(x, y));
}

export function areFriends(x, y) {
  return friendship(x, y)?.status === 'accepted';
}

function friendIds(id) {
  return all(`SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS id FROM friendships
              WHERE (a_id = ? OR b_id = ?) AND status = 'accepted'`, id, id, id).map((r) => r.id);
}

// Anfrage per Benutzername. Hat die andere Seite schon angefragt, gilt das als Annahme.
export function requestFriend(me, username) {
  const other = one('SELECT * FROM accounts WHERE username = ?', String(username ?? '').trim().replace(/^@/, ''));
  if (!other) throw new HttpError(404, 'Diesen Benutzernamen gibt es nicht.');
  if (other.id === me.id) throw new HttpError(400, 'Mit dir selbst bist du schon befreundet 😉');
  const f = friendship(me.id, other.id);
  if (f?.status === 'accepted') throw new HttpError(409, `Du bist mit ${other.name} schon verbunden.`);
  if (f && f.requested_by === me.id) throw new HttpError(409, 'Die Anfrage ist schon unterwegs.');
  if (f) return respondFriend(me, other.id, true);
  run(`INSERT INTO friendships (a_id, b_id, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
    ...pairKey(me.id, other.id), me.id, Date.now());
  notify(me.id, other.id);
  emit({ to: [other.id], kind: 'friend-request', actor: publicAccount(me) });
  return { status: 'pending', friend: publicAccount(other) };
}

export function respondFriend(me, otherId, accept) {
  const f = friendship(me.id, otherId);
  if (!f || f.status !== 'pending' || f.requested_by === me.id) throw new HttpError(404, 'Keine offene Anfrage von diesem Konto.');
  if (accept) {
    tx(() => {
      run(`UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE a_id = ? AND b_id = ?`, Date.now(), f.a_id, f.b_id);
      ensureList(f.a_id, f.b_id);
    });
  } else {
    run('DELETE FROM friendships WHERE a_id = ? AND b_id = ?', f.a_id, f.b_id);
  }
  notify(me.id, otherId);
  if (accept) emit({ to: [otherId], kind: 'friend-accepted', actor: publicAccount(me) });
  return { status: accept ? 'accepted' : 'declined', friend: getAccount(otherId) };
}

// Entfernt eine Freundschaft oder zieht eine eigene Anfrage zurück.
// Die gemeinsame Watchlist bleibt erhalten und ist nach erneutem Verbinden wieder da.
export function removeFriend(me, otherId) {
  const f = friendship(me.id, otherId);
  if (!f) throw new HttpError(404, 'Keine Verbindung mit diesem Konto.');
  run('DELETE FROM friendships WHERE a_id = ? AND b_id = ?', f.a_id, f.b_id);
  run('DELETE FROM invites WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', me.id, otherId, otherId, me.id);
  notify(me.id, otherId);
}

export function social(me) {
  const rows = all(`
    SELECT f.*, acc.id AS oid, acc.username, acc.name FROM friendships f
    JOIN accounts acc ON acc.id = CASE WHEN f.a_id = ? THEN f.b_id ELSE f.a_id END
    WHERE f.a_id = ? OR f.b_id = ?
    ORDER BY acc.name COLLATE NOCASE`, me.id, me.id, me.id);
  const person = (r) => ({ id: r.oid, username: r.username, name: r.name });
  return {
    friends: rows.filter((r) => r.status === 'accepted').map((r) => ({ ...person(r), since: r.accepted_at })),
    incoming: rows.filter((r) => r.status === 'pending' && r.requested_by !== me.id).map((r) => ({ ...person(r), at: r.created_at })),
    outgoing: rows.filter((r) => r.status === 'pending' && r.requested_by === me.id).map((r) => ({ ...person(r), at: r.created_at })),
  };
}

// --- Listen ----------------------------------------------------------------

function ensureList(x, y = null) {
  const [a, b] = y == null ? [x, null] : pairKey(x, y);
  const found = one('SELECT id FROM lists WHERE owner_a = ? AND IFNULL(owner_b, 0) = ?', a, b ?? 0);
  if (found) return found.id;
  return Number(run('INSERT INTO lists (owner_a, owner_b, created_at) VALUES (?, ?, ?)', a, b, Date.now()).lastInsertRowid);
}

const members = (list) => (list.owner_b == null ? [list.owner_a] : [list.owner_a, list.owner_b]);

// Prüft den Zugriff. Eine Paar-Liste gibt es nur, solange die beiden verbunden sind.
function accessList(me, listId) {
  const list = one('SELECT * FROM lists WHERE id = ?', Number(listId));
  const ms = list ? members(list) : [];
  if (!ms.includes(me.id) || (ms.length === 2 && !areFriends(ms[0], ms[1]))) {
    throw new HttpError(404, 'Diese Watchlist gibt es nicht (mehr).');
  }
  return { list, members: ms };
}

export function personalListId(me) {
  return ensureList(me.id);
}

export function pairListId(me, otherId) {
  if (!areFriends(me.id, otherId)) throw new HttpError(403, 'Ihr seid (noch) nicht verbunden.');
  return ensureList(me.id, otherId);
}

function describeList(me, list) {
  const partnerId = members(list).find((id) => id !== me.id) ?? null;
  const partner = partnerId ? getAccount(partnerId) : null;
  const c = one(`SELECT COUNT(*) AS total, COUNT(watched_at) AS watched,
                 SUM(CASE WHEN watched_at IS NULL AND vetoed_by IS NULL AND NOT EXISTS
                   (SELECT 1 FROM ratings r WHERE r.entry_id = w.id AND r.account_id = ? AND r.priority IS NOT NULL)
                 THEN 1 ELSE 0 END) AS unrated
                 FROM watchlist w WHERE list_id = ?`, me.id, list.id);
  const seen = one('SELECT seen_id FROM list_seen WHERE account_id = ? AND list_id = ?', me.id, list.id)?.seen_id ?? 0;
  const unread = one('SELECT COUNT(*) AS n FROM activities WHERE list_id = ? AND actor_id != ? AND id > ?', list.id, me.id, seen).n;
  return {
    id: list.id,
    kind: partner ? 'pair' : 'solo',
    partner,
    title: partner ? `Du & ${partner.name}` : 'Deine Liste',
    open: c.total - c.watched,
    watched: c.watched,
    unrated: c.unrated ?? 0,
    unread,
  };
}

// Eigene Liste zuerst, dann alle Paar-Listen mit aktuell verbundenen Konten
export function myLists(me) {
  const out = [describeList(me, one('SELECT * FROM lists WHERE id = ?', personalListId(me)))];
  for (const fid of friendIds(me.id)) out.push(describeList(me, one('SELECT * FROM lists WHERE id = ?', ensureList(me.id, fid))));
  return out;
}

// --- Watchlist-Einträge ----------------------------------------------------

export function listView(me, listId) {
  const { list, members: ms } = accessList(me, listId);
  const people = ms.map(getAccount);
  const entries = all('SELECT * FROM watchlist WHERE list_id = ?', list.id);
  const ratings = all(`SELECT r.* FROM ratings r JOIN watchlist w ON w.id = r.entry_id WHERE w.list_id = ?`, list.id);
  const byEntry = new Map();
  for (const r of ratings) {
    if (!byEntry.has(r.entry_id)) byEntry.set(r.entry_id, {});
    byEntry.get(r.entry_id)[r.account_id] = { priority: r.priority, stars: r.stars };
  }
  const comments = new Map(all(`SELECT entry_id, COUNT(*) AS n FROM activities WHERE list_id = ? AND kind = 'comment' GROUP BY entry_id`, list.id)
    .map((r) => [r.entry_id, r.n]));
  const out = entries.map((e) => {
    const rs = byEntry.get(e.id) || {};
    const prio = ms.map((id) => rs[id]?.priority ?? null);
    return {
      id: e.id,
      item: JSON.parse(e.card),
      addedBy: e.added_by,
      addedAt: e.added_at,
      watchedAt: e.watched_at,
      vetoedBy: e.vetoed_by,
      comments: comments.get(e.id) || 0,
      ratings: Object.fromEntries(ms.map((id) => [id, { priority: rs[id]?.priority ?? null, stars: rs[id]?.stars ?? null }])),
      score: prio.reduce((s, p) => s + (p ?? UNRATED), 0),
      // Für alle mindestens "will ich" → gemeinsamer Favorit
      together: ms.length > 1 && !e.vetoed_by && prio.every((p) => p != null && p >= 2),
    };
  });
  // Gesehenes nach Datum, Offenes nach gemeinsamer Wichtigkeit, Vetos ans Ende
  out.sort((a, b) =>
    a.watchedAt || b.watchedAt
      ? (b.watchedAt || 0) - (a.watchedAt || 0)
      : !b.vetoedBy - !a.vetoedBy || b.score - a.score || b.addedAt - a.addedAt);
  return { ...describeList(me, list), members: people, entries: out };
}

function entryFor(me, entryId) {
  const e = one('SELECT * FROM watchlist WHERE id = ?', Number(entryId));
  if (!e) throw new HttpError(404, 'Diesen Eintrag gibt es nicht (mehr).');
  return { entry: e, ...accessList(me, e.list_id) };
}

const touched = (ms) => notify(...ms);
const others = (ms, me) => ms.filter((id) => id !== me.id);
const itemOf = (entry) => {
  const c = JSON.parse(entry.card);
  return { id: c.id, name: c.name, poster: c.poster || null, year: c.year || null };
};

function logActivity(me, listId, entryId, kind, data = null) {
  return Number(run('INSERT INTO activities (list_id, entry_id, actor_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    listId, entryId, me.id, kind, data && JSON.stringify(data), Date.now()).lastInsertRowid);
}

// Eigene Aktionen gelten als gelesen
function markSeenUpTo(accountId, listId, activityId) {
  run(`INSERT INTO list_seen (account_id, list_id, seen_id) VALUES (?, ?, ?)
       ON CONFLICT (account_id, list_id) DO UPDATE SET seen_id = MAX(seen_id, excluded.seen_id)`, accountId, listId, activityId);
}

export function addEntry(me, listId, card, priority = null) {
  const { list, members: ms } = accessList(me, listId);
  if (!card?.id || !card.name) throw new HttpError(400, 'Unbekannter Titel.');
  const p = priority == null ? null : checkPriority(priority);
  const { id, fresh } = tx(() => {
    const ins = run(`INSERT INTO watchlist (list_id, item_id, card, added_by, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (list_id, item_id) DO NOTHING`, list.id, card.id, JSON.stringify(card), me.id, Date.now());
    const entryId = one('SELECT id FROM watchlist WHERE list_id = ? AND item_id = ?', list.id, card.id).id;
    if (p != null) setRating(me.id, entryId, { priority: p });
    if (ins.changes) markSeenUpTo(me.id, list.id, logActivity(me, list.id, entryId, 'add', { priority: p }));
    return { id: entryId, fresh: ins.changes > 0 };
  });
  touched(ms);
  if (fresh) emit({ to: others(ms, me), kind: 'add', actor: publicAccount(me), listId: list.id, item: itemOf({ card: JSON.stringify(card) }), priority: p });
  return id;
}

const checkPriority = (p) => {
  if (p === null) return null;
  const n = Number(p);
  if (!Number.isInteger(n) || n < 0 || n > 3) throw new HttpError(400, 'Ungültige Wichtigkeit.');
  return n;
};

function setRating(accountId, entryId, patch) {
  const cur = one('SELECT * FROM ratings WHERE entry_id = ? AND account_id = ?', entryId, accountId) || {};
  const next = { priority: cur.priority ?? null, stars: cur.stars ?? null, ...patch };
  run(`INSERT INTO ratings (entry_id, account_id, priority, stars) VALUES (?, ?, ?, ?)
       ON CONFLICT (entry_id, account_id) DO UPDATE SET priority = excluded.priority, stars = excluded.stars`,
    entryId, accountId, next.priority, next.stars);
}

// Ersetzt die eigene Aktivität einer Art zu einem Eintrag (z. B. Sterne), statt den Verlauf zuzumüllen
function replaceActivity(me, entry, kind, data) {
  run('DELETE FROM activities WHERE entry_id = ? AND actor_id = ? AND kind = ?', entry.id, me.id, kind);
  if (data !== undefined) markSeenUpTo(me.id, entry.list_id, logActivity(me, entry.list_id, entry.id, kind, data));
}

export function rateEntry(me, entryId, { priority, stars }) {
  const { entry, members: ms } = entryFor(me, entryId);
  const patch = {};
  if (priority !== undefined) patch.priority = checkPriority(priority);
  if (stars !== undefined) {
    const n = stars === null ? null : Number(stars);
    if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 5)) throw new HttpError(400, 'Ungültige Sterne.');
    patch.stars = n;
  }
  tx(() => {
    setRating(me.id, entry.id, patch);
    if ('stars' in patch) replaceActivity(me, entry, 'stars', patch.stars == null ? undefined : { stars: patch.stars });
  });
  touched(ms);
}

export function setWatched(me, entryId, watched) {
  const { entry, members: ms } = entryFor(me, entryId);
  tx(() => {
    run('UPDATE watchlist SET watched_at = ? WHERE id = ?', watched ? Date.now() : null, entry.id);
    if (watched) replaceActivity(me, entry, 'watched', null);
    else run(`DELETE FROM activities WHERE entry_id = ? AND kind = 'watched'`, entry.id);
  });
  touched(ms);
}

export function removeEntry(me, entryId) {
  const { entry, members: ms } = entryFor(me, entryId);
  run('DELETE FROM watchlist WHERE id = ?', entry.id);
  touched(ms);
}

// Veto: streicht einen Titel aus Zufallstipp und Watchlist-Sessions. Nur wer es eingelegt hat, nimmt es zurück.
export function vetoEntry(me, entryId, on) {
  const { entry, members: ms } = entryFor(me, entryId);
  if (on) {
    if (entry.vetoed_by) throw new HttpError(409, 'Gegen diesen Titel gibt es schon ein Veto.');
    tx(() => {
      run('UPDATE watchlist SET vetoed_by = ? WHERE id = ?', me.id, entry.id);
      replaceActivity(me, entry, 'veto', null);
    });
    emit({ to: others(ms, me), kind: 'veto', actor: publicAccount(me), listId: entry.list_id, item: itemOf(entry) });
  } else {
    if (entry.vetoed_by !== me.id) throw new HttpError(403, 'Dieses Veto hat jemand anderes eingelegt.');
    tx(() => {
      run('UPDATE watchlist SET vetoed_by = NULL WHERE id = ?', entry.id);
      replaceActivity(me, entry, 'veto', undefined);
    });
  }
  touched(ms);
}

export function addComment(me, entryId, text) {
  const { entry, members: ms } = entryFor(me, entryId);
  const t = String(text ?? '').trim().slice(0, 500);
  if (!t) throw new HttpError(400, 'Der Kommentar ist leer.');
  const id = logActivity(me, entry.list_id, entry.id, 'comment', { text: t });
  markSeenUpTo(me.id, entry.list_id, id);
  touched(ms);
  emit({ to: others(ms, me), kind: 'comment', actor: publicAccount(me), listId: entry.list_id, item: itemOf(entry), text: t });
  return id;
}

export function deleteComment(me, activityId) {
  const a = one(`SELECT * FROM activities WHERE id = ? AND kind = 'comment'`, Number(activityId));
  if (!a) throw new HttpError(404, 'Diesen Kommentar gibt es nicht (mehr).');
  const { members: ms } = accessList(me, a.list_id);
  if (a.actor_id !== me.id) throw new HttpError(403, 'Nur eigene Kommentare lassen sich löschen.');
  run('DELETE FROM activities WHERE id = ?', a.id);
  touched(ms);
}

// --- Reaktionen & Verlauf ---------------------------------------------------

export const REACTIONS = ['❤️', '😂', '😍', '🔥', '👍', '👎', '😱', '🙄', '🍿'];

export function react(me, activityId, emoji) {
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Diese Reaktion gibt es nicht.');
  const a = one('SELECT * FROM activities WHERE id = ?', Number(activityId));
  if (!a) throw new HttpError(404, 'Diese Aktivität gibt es nicht (mehr).');
  const { members: ms } = accessList(me, a.list_id);
  const had = run('DELETE FROM reactions WHERE activity_id = ? AND account_id = ? AND emoji = ?', a.id, me.id, emoji).changes;
  if (!had) run('INSERT INTO reactions (activity_id, account_id, emoji, created_at) VALUES (?, ?, ?, ?)', a.id, me.id, emoji, Date.now());
  touched(ms);
  if (!had && a.actor_id !== me.id) {
    const entry = a.entry_id && one('SELECT * FROM watchlist WHERE id = ?', a.entry_id);
    emit({ to: [a.actor_id], kind: 'reaction', actor: publicAccount(me), listId: a.list_id, emoji, on: a.kind, item: entry ? itemOf(entry) : null });
  }
  return !had;
}

// Verlauf einer Liste (oder nur eines Eintrags), neueste zuerst
export function activityFeed(me, listId, { entryId = null, before = null, limit = 50 } = {}) {
  const { list } = accessList(me, listId);
  const rows = all(`
    SELECT a.*, w.card, acc.name AS actor_name FROM activities a
    LEFT JOIN watchlist w ON w.id = a.entry_id
    JOIN accounts acc ON acc.id = a.actor_id
    WHERE a.list_id = ? AND (? IS NULL OR a.entry_id = ?) AND (? IS NULL OR a.id < ?)
    ORDER BY a.id DESC LIMIT ?`, list.id, entryId, entryId, before, before, Math.min(100, limit));
  const ids = rows.map((r) => r.id);
  const reacts = ids.length
    ? all(`SELECT r.*, acc.name FROM reactions r JOIN accounts acc ON acc.id = r.account_id
           WHERE activity_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at`, ...ids)
    : [];
  const seen = one('SELECT seen_id FROM list_seen WHERE account_id = ? AND list_id = ?', me.id, list.id)?.seen_id ?? 0;
  return rows.map((r) => {
    const mine = reacts.filter((x) => x.activity_id === r.id);
    const grouped = new Map();
    for (const x of mine) {
      if (!grouped.has(x.emoji)) grouped.set(x.emoji, { emoji: x.emoji, count: 0, mine: false, names: [] });
      const g = grouped.get(x.emoji);
      g.count++;
      g.names.push(x.name);
      if (x.account_id === me.id) g.mine = true;
    }
    return {
      id: r.id,
      kind: r.kind,
      entryId: r.entry_id,
      item: r.card ? itemOf(r) : null,
      actor: { id: r.actor_id, name: r.actor_name },
      data: r.data ? JSON.parse(r.data) : {},
      at: r.created_at,
      unread: r.actor_id !== me.id && r.id > seen,
      reactions: [...grouped.values()],
    };
  });
}

export function markSeen(me, listId) {
  const { list } = accessList(me, listId);
  const last = one('SELECT MAX(id) AS id FROM activities WHERE list_id = ?', list.id).id;
  if (last) markSeenUpTo(me.id, list.id, last);
  notify(me.id);
}

export function openEntries(me, listId) {
  const { list } = accessList(me, listId);
  return all('SELECT card FROM watchlist WHERE list_id = ? AND watched_at IS NULL AND vetoed_by IS NULL', list.id)
    .map((r) => JSON.parse(r.card));
}

export function listItemIds(me, listId) {
  const { list } = accessList(me, listId);
  return all('SELECT item_id FROM watchlist WHERE list_id = ?', list.id).map((r) => r.item_id);
}

// Alles, was eines der Konten in irgendeiner seiner Listen als gesehen markiert hat
export function watchedIds(accountIds) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const q = ids.map(() => '?').join(',');
  return new Set(all(`SELECT DISTINCT w.item_id FROM watchlist w JOIN lists l ON l.id = w.list_id
                      WHERE w.watched_at IS NOT NULL AND (l.owner_a IN (${q}) OR l.owner_b IN (${q}))`, ...ids, ...ids)
    .map((r) => r.item_id));
}

// --- Session-Einladungen ---------------------------------------------------

export function inviteToRoom(me, roomId, friendId) {
  if (!areFriends(me.id, friendId)) throw new HttpError(403, 'Einladen kannst du nur verbundene Konten.');
  run(`INSERT INTO invites (room_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, to_id) DO UPDATE SET created_at = excluded.created_at`, roomId, me.id, friendId, Date.now());
  notify(friendId);
  emit({ to: [friendId], kind: 'invite', actor: publicAccount(me), roomId });
}

export function invitesFor(me) {
  return all(`SELECT i.room_id, i.created_at, a.id, a.username, a.name FROM invites i
              JOIN accounts a ON a.id = i.from_id WHERE i.to_id = ? ORDER BY i.created_at DESC`, me.id)
    .map((r) => ({ roomId: r.room_id, at: r.created_at, from: { id: r.id, username: r.username, name: r.name } }));
}

export function dropInvite(roomId, accountId) {
  if (run('DELETE FROM invites WHERE room_id = ? AND to_id = ?', roomId, accountId).changes) notify(accountId);
}

export function dropRoomInvites(roomIds) {
  for (const id of roomIds) run('DELETE FROM invites WHERE room_id = ?', id);
}

// --- Push-Abos -------------------------------------------------------------

export function savePushSub(me, sub) {
  const endpoint = String(sub?.endpoint || '');
  const { p256dh, auth } = sub?.keys || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) throw new HttpError(400, 'Ungültiges Push-Abo.');
  run(`INSERT INTO push_subs (endpoint, account_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    endpoint, me.id, String(p256dh), String(auth), Date.now());
}

export function removePushSub(me, endpoint) {
  run('DELETE FROM push_subs WHERE endpoint = ? AND account_id = ?', String(endpoint || ''), me.id);
}

export const pushSubsOf = (accountId) => all('SELECT * FROM push_subs WHERE account_id = ?', accountId);
export const dropPushSub = (endpoint) => run('DELETE FROM push_subs WHERE endpoint = ?', endpoint);

// --- Admin -----------------------------------------------------------------

// ADMIN_USERS=lukas,anna — ohne Angabe ist das erste angelegte Konto Admin
export function isAdmin(acc) {
  if (!acc) return false;
  const list = String(process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list.includes(acc.username.toLowerCase());
  return one('SELECT MIN(id) AS id FROM accounts').id === acc.id;
}

// Kennzahlen ohne Inhalte einzelner Listen
export function stats(now = Date.now()) {
  const DAY = 86400000;
  const n = (sql, ...a) => one(sql, ...a).n ?? 0;
  const since = (d) => now - d * DAY;
  const perDay = (sql) => {
    const rows = new Map(all(sql, since(30)).map((r) => [r.day, r.n]));
    return Array.from({ length: 30 }, (_, i) => {
      const day = new Date(since(29 - i)).toISOString().slice(0, 10);
      return { day, n: rows.get(day) || 0 };
    });
  };
  return {
    accounts: {
      total: n('SELECT COUNT(*) AS n FROM accounts'),
      new7: n('SELECT COUNT(*) AS n FROM accounts WHERE created_at > ?', since(7)),
      new30: n('SELECT COUNT(*) AS n FROM accounts WHERE created_at > ?', since(30)),
      active7: n('SELECT COUNT(DISTINCT account_id) AS n FROM sessions WHERE last_seen > ?', since(7)),
      active30: n('SELECT COUNT(DISTINCT account_id) AS n FROM sessions WHERE last_seen > ?', since(30)),
      withPush: n('SELECT COUNT(DISTINCT account_id) AS n FROM push_subs'),
      solo: n(`SELECT COUNT(*) AS n FROM accounts a WHERE NOT EXISTS
               (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND (f.a_id = a.id OR f.b_id = a.id))`),
    },
    pairs: {
      total: n(`SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted'`),
      pending: n(`SELECT COUNT(*) AS n FROM friendships WHERE status = 'pending'`),
      withList: n(`SELECT COUNT(DISTINCT l.id) AS n FROM lists l JOIN watchlist w ON w.list_id = l.id
                   JOIN friendships f ON f.a_id = l.owner_a AND f.b_id = l.owner_b AND f.status = 'accepted'`),
      active7: n(`SELECT COUNT(DISTINCT l.id) AS n FROM lists l JOIN activities a ON a.list_id = l.id
                  WHERE l.owner_b IS NOT NULL AND a.created_at > ?`, since(7)),
    },
    watchlists: {
      entries: n('SELECT COUNT(*) AS n FROM watchlist'),
      open: n('SELECT COUNT(*) AS n FROM watchlist WHERE watched_at IS NULL'),
      watched: n('SELECT COUNT(*) AS n FROM watchlist WHERE watched_at IS NOT NULL'),
      vetoed: n('SELECT COUNT(*) AS n FROM watchlist WHERE vetoed_by IS NOT NULL'),
      manual: n(`SELECT COUNT(*) AS n FROM watchlist WHERE json_extract(card, '$.manual') = 1`),
      ratings: n('SELECT COUNT(*) AS n FROM ratings WHERE priority IS NOT NULL'),
      comments: n(`SELECT COUNT(*) AS n FROM activities WHERE kind = 'comment'`),
      reactions: n('SELECT COUNT(*) AS n FROM reactions'),
    },
    signups: perDay(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM accounts WHERE created_at > ? GROUP BY day`),
    activity: perDay(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM activities WHERE created_at > ? GROUP BY day`),
    topTitles: all(`SELECT item_id AS id, json_extract(card, '$.name') AS name, json_extract(card, '$.poster') AS poster,
                    COUNT(*) AS lists, COUNT(watched_at) AS watched
                    FROM watchlist GROUP BY item_id ORDER BY lists DESC, watched DESC LIMIT 10`),
    users: all(`SELECT a.id, a.username, a.name, a.created_at AS createdAt,
                (SELECT MAX(last_seen) FROM sessions s WHERE s.account_id = a.id) AS lastSeen,
                (SELECT COUNT(*) FROM friendships f WHERE f.status = 'accepted' AND (f.a_id = a.id OR f.b_id = a.id)) AS friends,
                (SELECT COUNT(*) FROM watchlist w WHERE w.added_by = a.id) AS added,
                EXISTS (SELECT 1 FROM push_subs p WHERE p.account_id = a.id) AS push
                FROM accounts a ORDER BY a.created_at DESC LIMIT 200`),
  };
}
