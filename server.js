const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 8788;
let browser = null;
let browserError = null;

/* ------------------------------------------------------------------
   ŹRÓDŁA
   Każde źródło to szablon adresu wyszukiwania i słowo, które musi
   wystąpić w kafelku, żeby uznać trafienie za nasze. Dopisuj tu sklepy,
   w których faktycznie kupujesz — mają strony renderowane serwerowo,
   ceny bez pośredników i nie blokują odczytu.
   ------------------------------------------------------------------ */
const SOURCES = [
  {
    id: 'skanowanie',
    name: 'Skanowanie.pl',
    url: q => `https://skanowanie.pl/?s=${encodeURIComponent(q)}&post_type=product`,
    tiles: 'li.product, .product, .type-product'
  }
];

const MIN_PRICE = 25;          // odsiewa ceny kabli i akcesoriów z listy
const PAGE_TIMEOUT = 20000;

/* ---------------- przeglądarka ---------------- */

async function startBrowser() {
  console.log('Uruchamianie przeglądarki…');
  browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // kontenery mają maleńki /dev/shm
      '--disable-gpu',
      '--single-process',          // 512 MB na darmowym planie Render
      '--no-zygote'
    ]
  });
  browser.on('disconnected', () => {
    console.error('Przeglądarka rozłączona — próbuję ponownie za 5 s');
    browser = null;
    setTimeout(() => startBrowser().catch(e => { browserError = e.message; }), 5000);
  });
  console.log('Przeglądarka gotowa\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

/* ---------------- robots.txt ----------------
   Sprawdzamy przed pierwszym pobraniem z danego hosta i zapamiętujemy
   wynik. Jeśli serwis nie zgadza się na automatyczny odczyt, źródło jest
   pomijane — bez wyjątków i bez obchodzenia tego w inny sposób.
   -------------------------------------------- */

const robotsCache = new Map();

function robotsAllows(txt, pathname) {
  const lines = txt.split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  const groups = [];
  let cur = null, lastWasAgent = false;

  for (const line of lines) {
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === 'disallow' || key === 'allow')) {
      lastWasAgent = false;
      cur.rules.push({ type: key, path: val });
    }
  }

  const group = groups.find(g => g.agents.includes('*'));
  if (!group) return { allowed: true, rule: 'brak reguł dla klientów ogólnych' };

  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue;                       // puste Disallow nie zabrania niczego
    if (pathname.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  }
  if (!best) return { allowed: true, rule: 'ścieżka nieobjęta regułą' };
  return { allowed: best.type === 'allow', rule: `${best.type}: ${best.path}` };
}

async function checkRobots(targetUrl) {
  const u = new URL(targetUrl);
  const key = u.origin + u.pathname.split('/')[1];
  if (robotsCache.has(key)) return robotsCache.get(key);

  let verdict;
  try {
    const res = await fetch(u.origin + '/robots.txt', {
      headers: { 'user-agent': 'PorownywarkaCen/1.0' }
    });
    verdict = res.ok
      ? robotsAllows(await res.text(), u.pathname + u.search)
      : { allowed: true, rule: 'brak pliku robots.txt' };
  } catch (e) {
    verdict = { allowed: false, rule: 'nie udało się pobrać robots.txt — nie ryzykuję' };
  }

  robotsCache.set(key, verdict);
  console.log(`robots.txt ${u.hostname}: ${verdict.allowed ? 'wolno' : 'ZABRONIONE'} (${verdict.rule})`);
  return verdict;
}

/* ---------------- pobieranie cen ---------------- */

async function getPriceFrom(source, query, mustContain) {
  const url = source.url(query);

  const robots = await checkRobots(url);
  if (!robots.allowed) return { price: null, url, skipped: robots.rule };

  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/121.0.0.0 Safari/537.36 PorownywarkaCen/1.0'
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await randomDelay(1200, 2000);

    return await page.evaluate((tilesSel, needle, minPrice) => {
      const priceRe = /(\d{1,3}(?:[\s\u00A0]*\d{3})*[.,]\d{2})\s*zł/g;
      const toNumber = s => {
        const v = parseFloat(s.replace(/[\s\u00A0]/g, '').replace(',', '.'));
        return isNaN(v) ? null : v;
      };

      const prices = [];
      let bestLink = '';

      document.querySelectorAll(tilesSel).forEach(tile => {
        const text = tile.innerText || '';
        if (needle && !text.toLowerCase().includes(needle.toLowerCase())) return;

        priceRe.lastIndex = 0;
        let m;
        while ((m = priceRe.exec(text)) !== null) {
          const v = toNumber(m[1]);
          if (v !== null && v > minPrice) {
            prices.push(v);
            if (!bestLink) {
              const a = tile.querySelector('a[href]');
              if (a) bestLink = a.href;
            }
          }
        }
      });

      return {
        price: prices.length ? Math.min(...prices) : null,
        url: bestLink || window.location.href
      };
    }, source.tiles, mustContain, MIN_PRICE);
  } catch (err) {
    return { price: null, url, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

/* Kolejność prób: EAN jest najpewniejszy, potem nazwa z modelem,
   na końcu sama nazwa. Przerywamy na pierwszym trafieniu. */
async function findBestPrice(ean, name, model) {
  const attempts = [];
  if (ean) attempts.push({ q: ean, needle: null, how: 'EAN' });
  if (name && model) attempts.push({ q: `${name} ${model}`, needle: name, how: 'nazwa + model' });
  if (name) attempts.push({ q: name, needle: name, how: 'nazwa' });
  if (model) attempts.push({ q: model, needle: null, how: 'model' });

  const skipped = [];

  for (const source of SOURCES) {
    for (const a of attempts) {
      const res = await getPriceFrom(source, a.q, a.needle);
      if (res.skipped) { skipped.push(`${source.name}: ${res.skipped}`); break; }
      if (res.price) {
        return { source: `${source.name} (${a.how})`, price: res.price, url: res.url };
      }
      await randomDelay(800, 1400);
    }
  }

  return { source: 'Brak', price: null, url: null, skipped };
}

/* ---------------- serwer ---------------- */

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // Strona główna — bez tego wejście na adres usługi zwraca 404,
  // a frontend musiałby być hostowany gdzie indziej.
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html' || reqUrl.pathname === '/strona.html') {
    const file = path.join(__dirname, 'strona.html');
    if (!fs.existsSync(file)) return json(404, { error: 'Brak pliku strona.html obok server.js' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file));
  }

  if (reqUrl.pathname === '/health') {
    return json(200, { ok: !!browser, error: browserError, sources: SOURCES.map(s => s.name) });
  }

  if (reqUrl.pathname !== '/check') return json(404, { error: 'Nieznana ścieżka' });

  // Bez tego zabezpieczenia browser.newPage() na null wywala cały proces
  if (!browser) {
    return json(503, { error: 'Przeglądarka jeszcze nie wystartowała', detail: browserError });
  }

  const ean = reqUrl.searchParams.get('ean') || '';
  const name = reqUrl.searchParams.get('name') || '';
  const model = reqUrl.searchParams.get('model') || '';
  if (!ean && !name && !model) return json(400, { error: 'Brak danych do szukania' });

  console.log(`\n--- Sprawdzam: nazwa [${name}] model [${model}] EAN [${ean}] ---`);
  try {
    const result = await findBestPrice(ean, name, model);
    console.log(result.price
      ? `-> ZNALEZIONO ${result.price} zł (${result.source})`
      : `-> BRAK OFERT${result.skipped && result.skipped.length ? ' — ' + result.skipped.join('; ') : ''}`);
    json(200, { ceneo: result, result });     // klucz "ceneo" dla zgodności ze starym frontendem
  } catch (err) {
    console.error('Błąd obsługi zapytania:', err.message);
    json(500, { error: err.message });
  }
}).listen(PORT, () => {
  console.log('===================================================');
  console.log(` Serwer uruchomiony na porcie ${PORT}`);
  console.log('===================================================');

  // Port jest już zajęty, więc awaria przeglądarki nie zabije usługi
  startBrowser().catch(err => {
    browserError = err.message;
    console.error('Przeglądarka nie wystartowała:', err.message);
  });
});

// Ostatnia siatka bezpieczeństwa — Node 24 kończy proces przy nieobsłużonym
// odrzuceniu, a to na Render oznacza "Port scan timeout" zamiast treści błędu.
process.on('unhandledRejection', err => {
  console.error('Nieobsłużone odrzucenie:', err && err.message ? err.message : err);
});
