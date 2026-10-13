// UI-Test für Konten: zwei "Handys" registrieren sich, verbinden sich, pflegen eine
// gemeinsame Watchlist, laden sich direkt zu einer Session ein und merken Matches.
// Aufruf: PLAYWRIGHT=/pfad/zu/playwright-core node scripts/e2e-accounts.mjs [baseUrl] [shotDir]
// Erwartet einen frischen Server (leere Datenbank).

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
  // 403 ist erwartet, wenn Anna die Statistik aufruft
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 403') && errors.push(`${who} console: ${m.text()}`));
  return page;
}

async function register(page, username, name) {
  await page.goto(BASE + '/login');
  await page.click('#switch');
  await page.fill('#u', username);
  await page.fill('#n', name);
  await page.fill('#p', 'geheim123');
  return page;
}

const lukas = await phoneFor('lukas');
const anna = await phoneFor('anna');

console.log('1. Registrieren');
await register(lukas, 'lukas', 'Lukas');
await lukas.screenshot({ path: `${SHOTS}/12-register.png` });
await lukas.click('#submit');
await lukas.waitForURL('**/konto');
await register(anna, 'anna', 'Anna');
await anna.click('#submit');
await anna.waitForURL('**/konto');
check('beide landen im Konto', true);

console.log('2. Anfragen & annehmen (live)');
await lukas.fill('#addName', 'anna');
await lukas.click('#addForm button');
await anna.waitForSelector('[data-do="accept"]', { timeout: 5000 });
check('Anfrage erscheint bei Anna ohne Neuladen', true);
check('Badge in der Kopfzeile', (await anna.textContent('.account-pill')).includes('1'));
await anna.screenshot({ path: `${SHOTS}/13-request.png` });
await anna.click('[data-do="accept"]');
await lukas.waitForSelector('.list-card:has-text("Du & Anna")', { timeout: 5000 });
check('Lukas sieht die gemeinsame Watchlist sofort', true);

console.log('3. Watchlist füllen und bewerten');
await lukas.click('.list-card:has-text("Du & Anna")');
await lukas.waitForSelector('#search');
for (const title of ['Inception', 'Interstellar', 'Heat']) {
  await lukas.fill('#search', title);
  const hit = lukas.locator('.hit', { has: lukas.locator(`b:text-is("${title}")`) }).first().locator('[data-add]');
  await hit.click();
  await lukas.waitForSelector(`.entry h4:has-text("${title}")`);
}
await lukas.fill('#search', 'Matrix');
await lukas.waitForSelector('.hit');
await lukas.screenshot({ path: `${SHOTS}/14-search.png` });
await lukas.fill('#search', '');
// Lukas: Inception unbedingt, Heat eher nicht
await lukas.click('.entry:has-text("Inception") [data-prio="3"]');
await lukas.click('.entry:has-text("Heat") [data-prio="0"]');

await anna.goto(BASE + '/konto');
await anna.click('.list-card:has-text("Du & Lukas")');
await anna.waitForSelector('.entry');
check('Anna sieht 3 Einträge', (await anna.locator('.entry').count()) === 3);
check('Annas unbewertete Einträge sind markiert', (await anna.locator('.entry.unrated').count()) === 3);
await anna.click('.entry:has-text("Inception") [data-prio="3"]');
await anna.click('.entry:has-text("Interstellar") [data-prio="1"]');
await anna.waitForTimeout(600);
const order = await anna.$$eval('.entry h4', (els) => els.map((e) => e.firstChild.textContent));
check(`Sortierung nach gemeinsamer Wichtigkeit: ${order.join(' > ')}`, order[0] === 'Inception' && order[2] === 'Heat');
check('„BEIDE"-Markierung bei Inception', (await anna.textContent('.entry:has-text("Inception") h4')).includes('BEIDE'));
await lukas.waitForSelector('.entry:has-text("Inception") .tag', { timeout: 5000 });
check('Lukas sieht Annas Bewertung live', true);
await anna.screenshot({ path: `${SHOTS}/15-watchlist.png`, fullPage: true });

console.log('4. Direkt-Einladung zur Session');
await lukas.goto(BASE + '/');
await lukas.waitForSelector('[data-invite]');
await lukas.click('[data-invite]');
await lukas.click('[data-count="5"]');
await lukas.waitForTimeout(500);
await lukas.screenshot({ path: `${SHOTS}/16-setup-friends.png`, fullPage: true });
await lukas.click('#create');
await lukas.waitForSelector('.overlay #friendInvites');
check('Einladen-Dialog zeigt Anna', (await lukas.textContent('#friendInvites')).includes('Anna'));
await lukas.click('.overlay [data-close]');

await anna.goto(BASE + '/');
await anna.waitForSelector('#invites .invite-banner', { timeout: 5000 });
await anna.screenshot({ path: `${SHOTS}/17-invite.png` });
await anna.click('#invites .invite-banner a');
await anna.waitForSelector('#join');
check('Angemeldet ohne Namensfeld', (await anna.locator('#name').count()) === 0);
await anna.click('#join');
await anna.waitForSelector('#stack .card.top');

console.log('5. Swipen, Matches merken');
for (const page of [lukas, anna]) {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(380);
    await page.locator('.overlay [data-close]').click({ timeout: 300 }).catch(() => {});
  }
}
await lukas.waitForTimeout(500);
await lukas.locator('.overlay').evaluateAll((els) => els.forEach((e) => e.remove()));
await lukas.click('#matchBtn');
await lukas.waitForSelector('#listPick');
check('Paar-Watchlist ist vorausgewählt', (await lukas.$eval('#listPick', (s) => s.selectedOptions[0].textContent)) === 'Du & Anna');
await lukas.click('[data-action="pin-all"]');
await lukas.waitForSelector('.result .pin.on');
await lukas.waitForTimeout(400);
await lukas.screenshot({ path: `${SHOTS}/18-results-pin.png` });
const pinnedCount = await lukas.locator('.result .pin.on').count();
check(`${pinnedCount} Matches gemerkt`, pinnedCount === 5);

console.log('6. Zufallstipp & gesehen');
await anna.goto(BASE + '/konto');
await anna.click('.list-card:has-text("Du & Lukas")');
await anna.waitForSelector('.entry');
check('Watchlist hat jetzt 8 Einträge', (await anna.locator('.entry').count()) === 8);
await anna.click('[data-act="pick"]');
await anna.waitForSelector('.overlay #take');
await anna.screenshot({ path: `${SHOTS}/19-pick.png` });
const picked = await anna.textContent('.overlay h2');
check(`Zufallstipp „${picked}" ist nicht Heat (eher nicht)`, picked !== 'Heat');
await anna.click('.overlay #take');
await anna.waitForTimeout(500);
await anna.click('[data-tab="seen"]');
await anna.waitForSelector('.entry [data-stars="4"]');
await anna.click('.entry [data-stars="4"]');
await anna.waitForTimeout(400);
await anna.screenshot({ path: `${SHOTS}/20-watched.png` });
check('Gesehen-Tab mit Sternen', (await anna.locator('.stars.edit button:not(.off)').count()) === 4);

console.log('7. Session aus der Watchlist');
await anna.click('[data-tab="open"]');
await anna.click('[data-act="session"]');
await anna.waitForSelector('.overlay .summary-list');
const summary = await anna.textContent('.overlay .summary-list');
check(`Watchlist-Session: ${summary.trim().slice(0, 60)}`, summary.includes('Watchlist von Anna & Lukas') && summary.includes('7 Titel'));
await anna.click('.overlay [data-close]');
await lukas.goto(BASE + '/konto');
await lukas.waitForSelector('#dyn .item-row');
await lukas.screenshot({ path: `${SHOTS}/21-konto.png`, fullPage: true });
check('Lukas hat Einladung zur Watchlist-Session', (await lukas.textContent('#dyn')).includes('lädt dich zu einer Session ein'));

console.log('8. Selbst eintragen, Verlauf, Reaktionen');
await anna.goto(BASE + '/konto');
await anna.click('.list-card:has-text("Du & Lukas")');
await anna.waitForSelector('#manualBtn');
await anna.fill('#search', 'Omas Lieblingsfilm');
await anna.waitForSelector('#results [data-manual]');
await anna.click('#results [data-manual]');
await anna.waitForSelector('#manualForm');
check('Titel aus der Suche vorausgefüllt', (await anna.inputValue('#mName')) === 'Omas Lieblingsfilm');
await anna.fill('#mYear', '1987');
await anna.fill('#mNote', 'läuft Sonntag auf Arte');
await anna.screenshot({ path: `${SHOTS}/22-manual.png` });
await anna.click('#manualForm .btn.primary');
await anna.waitForSelector('.entry:has-text("Omas Lieblingsfilm") .tag.manual');
check('selbst eingetragener Titel mit Platzhalter-Poster', (await anna.getAttribute('.entry:has-text("Omas Lieblingsfilm") img', 'src')).startsWith('/api/poster.svg'));

await lukas.goto(BASE + '/konto');
await lukas.waitForSelector('.list-card .badge-new', { timeout: 5000 });
check('Lukas sieht „neu"-Hinweis an der Liste', (await lukas.textContent('.list-card .badge-new')).includes('neu'));
await lukas.click('.list-card:has-text("Du & Anna")');
await lukas.waitForSelector('[data-tab="activity"] .dot');
await lukas.click('[data-tab="activity"]');
await lukas.waitForSelector('.activity.unread');
check('Verlauf zeigt Annas Eintrag als ungelesen', (await lukas.textContent('.activity.unread')).includes('Omas Lieblingsfilm'));
await lukas.click('.activity:has-text("Omas Lieblingsfilm") [data-picker]');
await lukas.click('.react-picker [data-react="😂"]');
await lukas.waitForSelector('.activity:has-text("Omas Lieblingsfilm") .react.on');

console.log('9. Kommentar & Veto in der Detailansicht');
await lukas.click('[data-tab="open"]');
await lukas.click('.entry:has-text("Interstellar") h4');
await lukas.waitForSelector('#commentForm');
await lukas.fill('#commentText', 'Nur mit Taschentüchern 😭');
await lukas.press('#commentText', 'Enter');
await lukas.waitForSelector('.thread .bubble:has-text("Taschentüchern")');
check('Kommentar erscheint im Thread', true);
await lukas.locator('.overlay .close').click();
await lukas.click('.entry:has-text("Heat") h4');
await lukas.waitForSelector('.overlay [data-act="veto"]');
lukas.once('dialog', (d) => d.accept());
await lukas.click('.overlay [data-act="veto"]');
await lukas.waitForSelector('.overlay [data-act="unveto"]');
check('Veto eingelegt, eigenes Veto zurücknehmbar', true);
await lukas.screenshot({ path: `${SHOTS}/23-detail.png` });
await lukas.locator('.overlay .close').click();
check('Veto-Eintrag ist ausgegraut', (await lukas.locator('.entry.vetoed:has-text("Heat")').count()) === 1);

await anna.goto(BASE + '/w/' + (await lukas.evaluate(() => location.pathname.split('/')[2])) + '?tab=activity');
await anna.waitForSelector('.activity .bubble:has-text("Taschentüchern")');
check('Anna sieht Kommentar und Veto im Verlauf', (await anna.textContent('#entries')).includes('Veto gegen'));
const reacted = anna.locator('.activity:has-text("Omas Lieblingsfilm") .react.on, .activity:has-text("Omas Lieblingsfilm") .react');
check('Lukas\' Reaktion ist bei Anna sichtbar', (await reacted.first().textContent()).includes('😂'));
await anna.click('.activity:has(.bubble) [data-picker]');
await anna.click('.react-picker [data-react="❤️"]');
await anna.waitForSelector('.activity:has(.bubble) .react.on');
await anna.screenshot({ path: `${SHOTS}/24-activity.png`, fullPage: true });
check('Session aus der Watchlist ohne Veto-Titel', (await anna.textContent('[data-act="session"]')).includes('(7)'));

console.log('10. Admin & Push-Bereich');
await lukas.goto(BASE + '/konto');
await lukas.waitForSelector('#push');
check('Push-Bereich vorhanden', (await lukas.textContent('#push')).length > 10);
check('Admin-Link für das erste Konto', (await lukas.locator('a[href="/admin"]').count()) === 1);
check('kein Admin-Link für Anna', await anna.goto(BASE + '/konto').then(() => anna.waitForSelector('#dyn .list-card')).then(async () => (await anna.locator('a[href="/admin"]').count()) === 0));
await lukas.click('a[href="/admin"]');
await lukas.waitForSelector('.tiles');
const tiles = await lukas.$$eval('.tile', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.tile-label').textContent, e.querySelector('.tile-value').textContent])));
check(`Statistik: ${tiles.Konten} Konten, ${tiles.Paare} Paar, ${tiles.Kommentare} Kommentar`, tiles.Konten === '2' && tiles.Paare === '1' && tiles.Kommentare === '1');
await lukas.screenshot({ path: `${SHOTS}/25-admin.png`, fullPage: true });
await anna.goto(BASE + '/admin');
await anna.waitForSelector('.center-screen');
check('Anna bekommt keine Statistik', (await anna.textContent('.center-screen')).includes('Nur für Admins'));

await browser.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(errors.length ? `JS-Fehler:\n  ${errors.join('\n  ')}` : 'Keine JS-Fehler');
console.log(failed.length || errors.length ? `E2E FEHLGESCHLAGEN (${failed.length} Checks)` : `E2E OK (${checks.length} Checks)`);
process.exit(failed.length || errors.length ? 1 : 0);
