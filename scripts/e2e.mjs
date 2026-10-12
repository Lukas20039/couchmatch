// UI-Test mit zwei "Handys": Host erstellt Session, Gast tritt per Link bei,
// beide swipen, Match-Popup und Ergebnisliste werden geprüft.
// Aufruf: PLAYWRIGHT=/pfad/zu/playwright-core node scripts/e2e.mjs [baseUrl] [shotDir]

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright-core');
const BASE = process.argv[2] || 'http://localhost:8095';
const SHOTS = process.argv[3] || '.jait/shots';

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${who} console: ${m.text()}`));
};

// Stimmungs-Vorlage in eigenem Kontext (eigener localStorage)
{
  const page = await (await browser.newContext(phone)).newPage();
  watch(page, 'mood');
  await page.goto(BASE);
  await page.waitForSelector('[data-mood="crime"]');
  const before = await page.textContent('#pool');
  await page.click('[data-mood="crime"]');
  await page.waitForTimeout(600);
  const on = await page.$$eval('#genres .chip.on', (els) => els.map((e) => e.textContent));
  const off = await page.$$eval('#genres .chip.off', (els) => els.map((e) => e.textContent));
  console.log('Stimmung Krimi → rein:', on.join(', '), '| raus:', off.join(', '), '| IMDb:', await page.textContent('#ratingVal'));
  console.log('  Pool vorher:', before.replace(/ —.*/, ''), '→ nachher:', (await page.textContent('#pool')).replace(/ —.*/, ''));
  await page.screenshot({ path: `${SHOTS}/00-mood.png` });
  await page.click('[data-genre="Thriller"]'); // Handänderung hebt die Vorlage auf
  console.log('  Vorlage nach Handänderung noch aktiv:', await page.locator('[data-mood="crime"].on').count() === 1);
  await page.context().close();
}

const hostCtx = await browser.newContext(phone);
const host = await hostCtx.newPage();
watch(host, 'host');
await host.goto(BASE);
await host.waitForSelector('#create:not([disabled])');
await host.waitForFunction(() => document.querySelector('#pool').textContent.includes('passende'));
// Serien abwählen, nur Klassiker, Komödie rein, Horror raus, 10 Titel
await host.click('[data-type="series"]');
await host.click('[data-cat="popular"]');
await host.click('[data-cat="toprated"]');
await host.click('[data-cat="classics"]');
await host.click('[data-genre="Comedy"]');
await host.click('[data-genre="Horror"]');
await host.click('[data-genre="Horror"]');
await host.click('[data-count="10"]');
await host.fill('#name', 'Lukas');
await host.waitForTimeout(600);
console.log('Setup:', await host.textContent('#pool'));
await host.screenshot({ path: `${SHOTS}/01-setup.png`, fullPage: true });

await host.click('#create');
await host.waitForSelector('.overlay input');
const link = await host.inputValue('.overlay input');
console.log('Einladungslink:', link);
await host.screenshot({ path: `${SHOTS}/02-invite.png` });
await host.click('[data-close]');
await host.waitForSelector('.card.top img');
await host.waitForTimeout(500);
await host.screenshot({ path: `${SHOTS}/03-swipe.png` });

const guestCtx = await browser.newContext(phone);
const guest = await guestCtx.newPage();
watch(guest, 'guest');
await guest.goto(link);
await guest.waitForSelector('#join');
await guest.screenshot({ path: `${SHOTS}/04-join.png` });
await guest.fill('#name', 'Anna');
await guest.click('#join');
await guest.waitForSelector('.card.top img');
await host.waitForFunction(() => document.querySelector('#players').textContent.includes('Anna'));
console.log('Host sieht:', await host.textContent('#players'));

// Echte Wisch-Geste nach rechts
async function drag(page, dx, dy) {
  const box = await page.locator('.card.top').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  await page.waitForTimeout(50);
  if (page === host && dx > 0) await page.screenshot({ path: `${SHOTS}/05-dragging.png` });
  await page.mouse.up();
  await page.waitForTimeout(450);
}
const topId = (page) => page.getAttribute('.card.top', 'data-id');

const first = await topId(host);
await drag(host, 220, 0); // Like
await drag(host, 0, -260); // Super
await drag(host, -220, 0); // Nope
await host.click('[data-act="maybe"]');
await host.waitForTimeout(450);
console.log('Host nach 4 Swipes:', await host.textContent('#players'));

// Rückgängig testen
const beforeUndo = await topId(host);
await host.click('[data-act="undo"]');
await host.waitForTimeout(300);
const afterUndo = await topId(host);
console.log('Undo bringt Karte zurück:', afterUndo !== beforeUndo);
await host.click('[data-act="maybe"]');
await host.waitForTimeout(450);

// Gast liked die erste Karte → Match-Popup bei beiden
if ((await topId(guest)) !== first) throw new Error('Gast hat andere Reihenfolge');
await guest.click('[data-act="like"]');
await host.waitForSelector('.match-pop', { timeout: 5000 });
await guest.waitForSelector('.match-pop', { timeout: 5000 });
console.log('Match-Popup:', (await host.textContent('.match-pop h3')).trim());
await guest.screenshot({ path: `${SHOTS}/06-match.png` });
await guest.click('[data-close]');
await host.click('[data-close]');

// Gast: like (Host Super), like (Host Nope), like (Host interessant) — jedes Match öffnet ein Popup
const dismiss = async (p) => p.locator('.overlay [data-close]').click({ timeout: 700 }).catch(() => {});
await guest.click('[data-act="like"]');
await guest.waitForTimeout(600);
await dismiss(guest);
await drag(guest, 230, 0);
await dismiss(guest);
await guest.click('[data-act="like"]');
await guest.waitForTimeout(600);
for (const p of [host, guest]) await dismiss(p);

// Rest: beide liken alles → genug Matches für ein Finale
for (const p of [host, guest]) {
  while (await p.locator('.card.top').count()) {
    await p.locator('.overlay [data-close]').click({ timeout: 200 }).catch(() => {});
    await p.click('[data-act="like"]');
    await p.waitForTimeout(350);
  }
}
// Matches, die beim Host erst durch die letzten Swipes des Gastes entstanden sind
await host.waitForTimeout(800);
while (await host.locator('.match-pop').count()) {
  await host.locator('.overlay [data-close]').click();
  await host.waitForTimeout(150);
}
await guest.locator('.overlay [data-close]').click({ timeout: 600 }).catch(() => {});
await host.waitForSelector('#resultsBtn');
await host.screenshot({ path: `${SHOTS}/07-done.png` });
await host.click('#resultsBtn');
await host.waitForSelector('.result');
await host.click('[data-action="random"]');
await host.waitForTimeout(800);
const results = await host.$$eval('.overlay .result h4', (els) => els.map((e) => e.textContent));
console.log('Ergebnisse:', results.length, 'Matches');
await host.screenshot({ path: `${SHOTS}/08-results.png` });

// Trailer-Modal
await host.locator('.overlay .result [data-trailer]').first().click();
// Manche Titel haben keinen Trailer — dann gibt es einen YouTube-Suchlink
await host.waitForSelector('iframe.video, .overlay a.btn[href*="youtube.com/results"]');
console.log('Trailer:', (await host.locator('iframe.video').count())
  ? await host.getAttribute('iframe.video', 'src')
  : 'keiner hinterlegt → Suchlink');
await host.locator('.overlay').last().locator('.close').click();

// Veto: Gast streicht den ersten Volltreffer, Host sieht es live
await guest.click('#matchBtn');
await guest.waitForSelector('[data-action="veto"]');
const vetoed = (await guest.locator('.result:has([data-action="veto"]) h4').first().textContent()).replace(/MATCH|VIELLEICHT/, '');
await guest.locator('[data-action="veto"]').first().click();
await host.waitForSelector('.result.vetoed', { timeout: 5000 });
console.log('Veto von Anna:', vetoed, '→ Host sieht:', (await host.textContent('.result.vetoed .sub')).trim());
console.log('  Weiteres Veto möglich:', await guest.locator('[data-action="veto"]:not([disabled])').count() > 1 ? 'ja (Fehler!)' : 'nein, Joker verbraucht');
await host.screenshot({ path: `${SHOTS}/09-veto.png` });

// Finale: Host startet, Gast bekommt es automatisch angezeigt
await host.click('[data-action="final-start"]');
await host.waitForSelector('.duel');
await guest.waitForSelector('.duel', { timeout: 5000 });
console.log('Finale:', (await host.textContent('.sheet h2')).trim());
await host.screenshot({ path: `${SHOTS}/10-duel.png` });
console.log('Duell-Layout:', JSON.stringify(await host.evaluate(() => {
  const s = document.querySelector('.sheet');
  const cards = [...document.querySelectorAll('.duel-card')].map((c) => Math.round(c.getBoundingClientRect().width));
  const img = document.querySelector('.duel-card img').getBoundingClientRect();
  return { overflowX: s.scrollWidth > s.clientWidth, cards, poster: [Math.round(img.width), Math.round(img.height)], sheetBottom: Math.round(document.querySelector('.duel').getBoundingClientRect().bottom), vh: innerHeight };
})));
let duels = 0;
while (!(await host.locator('.final-winner').count())) {
  for (const [p, pick] of [[host, 'first'], [guest, duels % 2 ? 'first' : 'last']]) {
    const cards = p.locator('.duel-card img');
    if (await cards.count()) {
      await cards[pick]().click();
      await p.waitForTimeout(250);
    }
  }
  duels++;
  await host.waitForTimeout(400);
  if (duels > 20) throw new Error('Finale endet nicht');
}
await guest.waitForSelector('.final-winner', { timeout: 5000 });
const winner = (await host.textContent('.final-winner h2')).trim();
console.log(`Finale entschieden nach ${duels} Klickrunden — Sieger: ${winner} (Gast sieht: ${(await guest.textContent('.final-winner h2')).trim()})`);
console.log('Verlauf:', (await host.locator('.final-winner ~ details li').allTextContents()).join(' | '));
await host.screenshot({ path: `${SHOTS}/11-winner.png` });

console.log(errors.length ? 'FEHLER:\n' + errors.join('\n') : 'Keine JS-Fehler');
await browser.close();
process.exit(errors.length || results.length < 2 ? 1 : 0);
