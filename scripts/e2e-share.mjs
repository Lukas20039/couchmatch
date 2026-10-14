// UI-Test fürs Teilen aus TikTok & Co.: geteilter Text → erkannter Titel → Watchlist.
// Aufruf: PLAYWRIGHT=/pfad/zu/playwright-core node scripts/e2e-share.mjs [baseUrl] [shotDir]
// Erwartet einen frischen Server (leere Datenbank). Der YouTube-Teil braucht Internet.

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright-core');
const BASE = process.argv[2] || 'http://localhost:8095';
const SHOTS = process.argv[3] || '.jait/shots';

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const checks = [];
const check = (label, ok) => {
  checks.push([label, ok]);
  console.log(ok ? '  ✓' : '  ✗', label);
};

async function phoneFor(who) {
  const page = await (await browser.newContext(phone)).newPage();
  page.on('pageerror', (e) => errors.push(`${who}: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${who} console: ${m.text()}`));
  return page;
}
const share = (p) => BASE + '/teilen?' + new URLSearchParams(p);

console.log('1. Manifest');
const manifest = await (await fetch(BASE + '/manifest.webmanifest')).json();
check('Teilen-Ziel im Manifest', manifest.share_target?.action === '/teilen' && manifest.share_target.params.url === 'url');

console.log('2. Geteilt ohne Anmeldung → Login → zurück');
const lukas = await phoneFor('lukas');
const anna = await phoneFor('anna');
await lukas.goto(share({ text: 'wait for the ending 🤯 Film: Interstellar #fyp https://example.com/v/1' }));
await lukas.waitForURL('**/login?next=*');
await lukas.click('#switch');
await lukas.fill('#u', 'lukas');
await lukas.fill('#n', 'Lukas');
await lukas.fill('#p', 'geheim123');
await lukas.click('#submit');
await lukas.waitForURL('**/teilen?*');
check('nach dem Registrieren wieder auf der Teilen-Seite', true);

// Anna verbinden, damit es eine gemeinsame Liste gibt
await anna.goto(BASE + '/login');
await anna.click('#switch');
await anna.fill('#u', 'anna');
await anna.fill('#n', 'Anna');
await anna.fill('#p', 'geheim123');
await anna.click('#submit');
await anna.waitForURL('**/konto');
await anna.fill('#addName', 'lukas');
await anna.click('#addForm button');
await lukas.goto(BASE + '/konto');
await lukas.click('[data-do="accept"]');
await lukas.waitForSelector('.list-card:has-text("Anna")');

console.log('3. Titel erkennen und hinzufügen');
await lukas.goto(share({ text: 'wait for the ending 🤯 Film: Interstellar #fyp https://example.com/v/1' }));
await lukas.waitForSelector('#found .hit');
check('Interstellar erkannt', (await lukas.textContent('#found .hit')).includes('Interstellar'));
check('Quelle und Caption angezeigt', (await lukas.textContent('#src')).includes('Film: Interstellar'));
const chips = await lukas.locator('#lists .chip').count();
if (chips) await lukas.click('#lists .chip:has-text("Anna")');
await lukas.screenshot({ path: `${SHOTS}/30-share.png` });
await lukas.click('#found .hit:has-text("Interstellar") [data-add]');
await lukas.waitForURL(/\/w\/\d+$/);
await lukas.waitForSelector('.entry:has-text("Interstellar")');
check('auf der Watchlist gelandet', true);
await lukas.click('[data-tab="activity"]');
await lukas.waitForSelector('.activity .bubble');
check('Link als Kommentar', (await lukas.textContent('#entries')).includes('https://example.com/v/1'));
await anna.goto(BASE + '/konto');
await anna.waitForSelector('.list-card .badge-new', { timeout: 5000 });
check('Anna bekommt den neuen Eintrag mit', true);

console.log('4. Nichts erkannt → selbst eintragen, vorausgefüllt');
await lukas.goto(share({ text: 'Serie: Omas Geheimtipp 🥹 https://www.tiktok.com/@nobody/video/1' }));
await lukas.waitForSelector('#src .sub');
await lukas.waitForFunction(() => document.getElementById('search').value !== '');
check('Suchfeld mit erkanntem Titel', (await lukas.inputValue('#search')) === 'Omas Geheimtipp');
check('Quelle TikTok', (await lukas.textContent('#src')).includes('TikTok'));
await lukas.click('#manualBtn');
await lukas.waitForSelector('#manualForm');
check('Dialog mit Titel', (await lukas.inputValue('#mName')) === 'Omas Geheimtipp');
check('Dialog mit Link als Notiz', (await lukas.inputValue('#mNote')) === 'https://www.tiktok.com/@nobody/video/1');
check('Parameter aus der Adresse entfernt', !(await lukas.evaluate(() => location.search)));
await lukas.screenshot({ path: `${SHOTS}/31-share-manual.png` });
await lukas.click('#manualForm .btn.primary');
await lukas.waitForSelector('.entry:has-text("Omas Geheimtipp")');
check('selbst eingetragen', true);

console.log('5. Link einfügen (iPhone)');
await lukas.click('a[href="/teilen"]');
await lukas.waitForSelector('#pasteLink');
await lukas.screenshot({ path: `${SHOTS}/32-share-paste.png` });
await lukas.fill('#pasteLink', 'https://www.youtube.com/watch?v=vKQi3bBA1y8');
await lukas.click('#pasteForm .btn');
await lukas.waitForSelector('#found .hit, #found .hint', { timeout: 15000 });
check('YouTube-Trailer → The Matrix', (await lukas.textContent('#found')).includes('The Matrix'));
await lukas.screenshot({ path: `${SHOTS}/33-share-youtube.png` });

await browser.close();
if (errors.length) console.log('JS-Fehler:\n' + errors.join('\n'));
else console.log('Keine JS-Fehler');
const failed = checks.filter(([, ok]) => !ok).length + errors.length;
console.log(failed ? `E2E FEHLGESCHLAGEN (${failed})` : `E2E OK (${checks.length} Checks)`);
process.exit(failed ? 1 : 0);
