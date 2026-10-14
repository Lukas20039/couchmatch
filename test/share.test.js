import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTitles } from '../lib/catalog.js';
import { extractLink, resolveShare, sourceOf } from '../lib/share.js';

const it = (id, name, year, topRank = null) => ({ id, name, year, type: 'movie', topRank, yearRank: null, poster: 'p', genres: [] });
const ITEMS = [
  it('tt1', 'The Matrix', 1999, 10),
  it('tt2', 'The Matrix Resurrections', 2021, 500),
  it('tt3', 'Dark', 2017, 50),
  it('tt4', 'Home', 2015, 900),
  it('tt5', 'Der Schacht', 2019, 300),
  it('tt6', 'Inception', 2010, 5),
  it('tt7', 'Interstellar', 2014, 4),
  it('tt8', 'Love', 2015, 800),
  it('tt9', 'Parasite', 2019, 20),
  it('tt10', 'The Grand Budapest Hotel', 2014, 30),
  it('tt11', 'Hotel', 2004, 4000),
];
const names = (text) => matchTitles(text, 8, ITEMS).hits.map((h) => h.name);

test('ausdrücklich genannter Titel steht vorn', () => {
  assert.equal(names('Unfassbar gut 😳 Film: Der Schacht #fyp #filmtok')[0], 'Der Schacht');
  assert.equal(names('Wer kennt „Inception\" noch? 🤯')[0], 'Inception');
  assert.equal(names('🎬 Parasite (2019)\nmust watch')[0], 'Parasite');
});

test('Hashtags werden erkannt, Allerwelts-Tags nicht', () => {
  assert.deepEqual(names('omg #interstellar #movie #fyp #love'), ['Interstellar']);
});

test('Wortgruppen im Text, längere Titel und passendes Jahr gewinnen', () => {
  const r = names('THE MATRIX Official Trailer (1999)');
  assert.equal(r[0], 'The Matrix');
  assert.equal(names('rewatching the matrix resurrections tonight')[0], 'The Matrix Resurrections');
  // Teil eines längeren Treffers zählt nicht extra
  assert.deepEqual(names('Top 3: 1. Parasite 2. The Grand Budapest Hotel'), ['The Grand Budapest Hotel', 'Parasite']);
});

test('kurze Allerweltswörter ergeben keinen Treffer', () => {
  assert.deepEqual(names('back home with my love, so dark outside'), []);
  assert.deepEqual(matchTitles('', 8, ITEMS), { hits: [], query: '' });
});

test('Suchbegriff fällt auf den ausdrücklichen Titel zurück, auch ohne Treffer', () => {
  assert.equal(matchTitles('Serie: Völlig Unbekannt #fyp', 8, ITEMS).query, 'Völlig Unbekannt');
  assert.equal(matchTitles('Serie: Omas Geheimtipp 🥹 https://x', 8, ITEMS).query, 'Omas Geheimtipp');
});

test('Satz nach dem Titel geht weiter', () => {
  assert.equal(names('Serie: Dark ist einfach so gut, ehrlich')[0], 'Dark');
  assert.equal(names('Film - Inception. Danach war ich sprachlos')[0], 'Inception');
});

test('Link und Plattform aus geteilten Feldern', () => {
  assert.equal(extractLink({ text: 'Schau dir das an! https://vm.tiktok.com/ZMabc123/ 😂' }), 'https://vm.tiktok.com/ZMabc123/');
  assert.equal(extractLink({ url: '', text: 'nix' }), null);
  assert.equal(sourceOf('https://www.instagram.com/reel/abc/'), 'instagram');
  assert.equal(sourceOf('https://youtu.be/xyz'), 'youtube');
  assert.equal(sourceOf('https://evil-tiktok.com/x'), null);
  assert.equal(sourceOf('https://example.com'), null);
});

// Kleiner Fake für fetch: URL -> Antwort
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    if (r.redirect) return new Response(null, { status: 301, headers: { location: r.redirect } });
    return new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

test('TikTok-Kurzlink: Weiterleitung folgen, dann oEmbed', async () => {
  const video = 'https://www.tiktok.com/@kino/video/7123';
  const f = fakeFetch({
    'https://vm.tiktok.com/ZMabc/': { redirect: video + '?is_from_webapp=1' },
    [video + '?is_from_webapp=1']: '<html></html>',
    [`https://www.tiktok.com/oembed?url=${encodeURIComponent(video)}`]: { title: 'Film: Der Schacht 😳 #fyp', author_name: 'Kino Tipps' },
  });
  const r = await resolveShare({ text: 'https://vm.tiktok.com/ZMabc/' }, { fetchImpl: f });
  assert.equal(r.source, 'TikTok');
  assert.equal(r.caption, 'Film: Der Schacht 😳 #fyp');
  assert.equal(r.author, 'Kino Tipps');
});

test('Weiterleitung auf fremde Seite wird nicht verfolgt', async () => {
  const f = fakeFetch({ 'https://vm.tiktok.com/x/': { redirect: 'http://169.254.169.254/latest' } });
  const r = await resolveShare({ url: 'https://vm.tiktok.com/x/' }, { fetchImpl: f });
  assert.equal(r.caption, '');
  assert.deepEqual(f.calls, ['https://vm.tiktok.com/x/']);
});

test('Instagram: Caption aus den Meta-Tags, Login-Seite ergibt nichts', async () => {
  const post = 'https://www.instagram.com/reel/C1/';
  const html = `<meta property="og:title" content="Netflix on Instagram: &quot;Wer hat&#039;s schon gesehen? 🎬 Parasite&quot;" />
    <meta property="og:description" content="12K likes, 300 comments - netflix on May 1, 2025: &quot;Wer hat&#039;s schon gesehen? 🎬 Parasite&quot;." />`;
  let r = await resolveShare({ url: post + '?igsh=abc' }, { fetchImpl: fakeFetch({ [post]: html }) });
  assert.equal(r.source, 'Instagram');
  assert.equal(r.caption, "Wer hat's schon gesehen? 🎬 Parasite");
  assert.equal(r.author, 'Netflix');
  r = await resolveShare({ url: post }, { fetchImpl: fakeFetch({ [post]: '<meta property="og:title" content="Instagram" />' }) });
  assert.equal(r.caption, '');
});

test('fremde Links werden nicht abgerufen, geteilter Text bleibt', async () => {
  const f = fakeFetch({});
  const r = await resolveShare({ title: 'Inception', url: 'https://example.com/x' }, { fetchImpl: f });
  assert.equal(r.source, 'Link');
  assert.equal(r.shared, 'Inception');
  assert.equal(f.calls.length, 0);
});
