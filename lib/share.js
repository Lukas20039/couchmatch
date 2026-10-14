// couchmatch — geteilte Links (TikTok, Instagram, YouTube) auflösen: Link finden und Caption holen.
// Abgerufen werden nur bekannte Plattformen, auch nach Weiterleitungen.

const HOSTS = {
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com', 'instagr.am'],
  youtube: ['youtube.com', 'youtu.be'],
};
const LABEL = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export function sourceOf(link) {
  let host;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [src, list] of Object.entries(HOSTS)) {
    if (list.some((h) => host === h || host.endsWith('.' + h))) return src;
  }
  return null;
}

// Erster Link aus url/text/title — Apps verteilen ihn unterschiedlich auf die Felder
export function extractLink({ url, text, title } = {}) {
  for (const s of [url, text, title]) {
    const m = String(s || '').match(/https?:\/\/[^\s<>"'„“]+/i);
    if (m) return m[0].replace(/[).,!?]+$/, '');
  }
  return null;
}

const decode = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function metaTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decode(content) : null;
}

// GET mit Weiterleitungen von Hand, damit wir die Plattform nie verlassen
async function get(link, { fetchImpl, headers = {} }) {
  let url = link;
  for (let hop = 0; hop < 5; hop++) {
    if (!/^https:/i.test(url) || !sourceOf(url)) return null;
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    if (!res.ok) return null;
    return { url, body: (await res.text()).slice(0, 600_000) };
  }
  return null;
}

async function oembed(endpoint, fetchImpl) {
  const res = await get(endpoint, { fetchImpl, headers: { accept: 'application/json' } });
  if (!res) return null;
  try {
    const j = JSON.parse(res.body);
    return { caption: String(j.title || ''), author: String(j.author_name || '') };
  } catch {
    return null;
  }
}

// Instagram: Caption steckt in og:title/og:description („… on Instagram: "Caption"")
function instagramCaption(html) {
  const title = metaTag(html, 'og:title') || '';
  const desc = metaTag(html, 'og:description') || metaTag(html, 'description') || '';
  if (!title && !desc) return null;
  const quoted = (s) => s.match(/:\s*["“](.+)["”]\s*\.?\s*$/s)?.[1];
  const caption = quoted(desc) || quoted(title) || desc;
  // Login-Seite statt Beitrag
  if (/^instagram$/i.test(title.trim()) || /Followers, .* Following/.test(caption)) return null;
  const author = title.match(/^(.+?) (?:on|auf) Instagram/i)?.[1] || desc.match(/ - ([^ ]+) (?:on|am) /)?.[1] || '';
  return { caption, author };
}

export async function resolveShare(input, { fetchImpl = fetch } = {}) {
  const link = extractLink(input);
  const source = link && sourceOf(link);
  // Geteilter Text ohne den Link — oft steht der Titel schon drin
  const shared = [input?.title, input?.text].filter(Boolean).join('\n').replace(/https?:\/\/\S+/g, ' ').trim();
  let meta = null;
  try {
    if (source === 'tiktok') {
      // Kurzlinks (vm.tiktok.com) erst auflösen; die oEmbed-API will die volle Video-URL
      const page = /\/video\/\d+/.test(link) ? { url: link } : await get(link, { fetchImpl });
      const clean = page?.url.split('?')[0];
      if (clean) meta = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(clean)}`, fetchImpl);
    } else if (source === 'youtube') {
      meta = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`, fetchImpl);
    } else if (source === 'instagram') {
      const page = await get(link.split('?')[0], { fetchImpl });
      if (page) meta = instagramCaption(page.body);
    }
  } catch {
    // Plattform nicht erreichbar — dann eben nur mit dem geteilten Text
  }
  return {
    link,
    source: source ? LABEL[source] : link ? 'Link' : null,
    caption: meta?.caption?.trim().slice(0, 2000) || '',
    author: meta?.author || '',
    shared: shared.slice(0, 1000),
  };
}
