// End-to-End gegen einen laufenden Server: zwei Spieler, Live-Stream, Match.
// Aufruf: node scripts/smoke.mjs [http://localhost:8095]

const BASE = process.argv[2] || 'http://localhost:8095';
const post = async (p, body) => {
  const r = await fetch(BASE + '/api' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${r.status} ${j.error}`);
  return j;
};

const filters = { types: ['movie'], categories: ['classics'], genres: ['Comedy'], minRating: 7.5 };
const pre = await post('/preview', { filters });
console.log('Pool:', pre.available, 'Filme');

const host = await post('/rooms', { filters, count: 5, superLimit: 1, name: 'Lukas' });
const guest = await post(`/rooms/${host.roomId}/join`, { name: 'Anna' });

// Live-Stream des Hosts mitlesen
const events = [];
const ctrl = new AbortController();
const stream = await fetch(`${BASE}/api/rooms/${host.roomId}/events?playerId=${host.playerId}&token=${host.token}`, { signal: ctrl.signal });
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of stream.body) {
      buf += dec.decode(chunk);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (msg.startsWith('data: ')) events.push(JSON.parse(msg.slice(6)));
      }
    }
  } catch {}
})();
await new Promise((r) => setTimeout(r, 300));
const items = events[0].items;
console.log('Titel:', items.map((i) => `${i.name} (${i.year}, ${i.rating}, Trailer: ${i.trailer ? 'ja' : 'nein'})`).join(' | '));

await post(`/rooms/${host.roomId}/vote`, { ...host, itemId: items[0].id, vote: 'super' });
await post(`/rooms/${host.roomId}/vote`, { ...host, itemId: items[1].id, vote: 'maybe' });
await post(`/rooms/${host.roomId}/vote`, { ...host, itemId: items[2].id, vote: 'nope' });
await post(`/rooms/${host.roomId}/vote`, { playerId: guest.playerId, token: guest.token, itemId: items[0].id, vote: 'like' });
await post(`/rooms/${host.roomId}/vote`, { playerId: guest.playerId, token: guest.token, itemId: items[1].id, vote: 'like' });
await post(`/rooms/${host.roomId}/vote`, { playerId: guest.playerId, token: guest.token, itemId: items[2].id, vote: 'super' });
const superFail = await fetch(`${BASE}/api/rooms/${host.roomId}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...host, itemId: items[3].id, vote: 'super' }) });
const badToken = await fetch(`${BASE}/api/rooms/${host.roomId}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: guest.playerId, token: 'x', itemId: items[3].id, vote: 'like' }) });
const more = await post(`/rooms/${host.roomId}/more`, { ...host, count: 3 });
await new Promise((r) => setTimeout(r, 300));
ctrl.abort();

const last = events.at(-1);
console.log('SSE-Events:', events.length);
console.log('Matches:', last.matches.map((m) => `${items.find((i) => i.id === m.id).name} score=${m.score} strong=${m.strong}`));
console.log('2. Super-Like abgelehnt:', superFail.status, '| falscher Token:', badToken.status, '| mehr Titel:', more.added, '→', last.items.length);
const ok = last.matches.length === 2 && last.matches[0].strong && !last.matches[1].strong && superFail.status === 409 && badToken.status === 403 && last.items.length === 8;
console.log(ok ? 'SMOKE OK' : 'SMOKE FEHLGESCHLAGEN');
process.exit(ok ? 0 : 1);
