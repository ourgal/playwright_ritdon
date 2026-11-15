// Fill titles/intros.json with book blurbs (內容簡介) from books.com.tw, for EVERY volume of every
// title in titles/metadata.csv — not only the volume ritdon happened to hand us.
//
// Source: books.com.tw through a local FlareSolverr (Cloudflare bypass).
//   1. https://search.books.com.tw/search/query/key/<base title|isbn>/cat/all   -> every prod id of the series
//   2. https://www.books.com.tw/products/<id>                                   -> that volume's 內容簡介
// books.com.tw is Traditional Chinese, so blurbs are converted to Simplified (opencc-js, --keep-hant to skip).
// Existing intros.json blurbs (readmoo etc.) are never overwritten; this source adds `volumes`.
//
// caches: titles/books_tw.json         per library title -> series search hits
//         titles/books_tw_volumes.json per product id    -> blurb (fetched once, shared across titles)
// usage:  node scripts/fetch_intros.mjs [--limit N] [--refresh] [--keep-hant] [--delay 5000] [--q "<title|isbn>"]
//         --merge-only rewrites intros.json/intros.csv from the caches without touching the network
//         FLARESOLVERR_URL overrides the endpoint (default http://localhost:8191/v1)
import fs from 'node:fs';
import path from 'node:path';
import * as OpenCC from 'opencc-js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'titles', 'metadata.csv');
const CACHE = path.join(ROOT, 'titles', 'books_tw.json');
const VOLS = path.join(ROOT, 'titles', 'books_tw_volumes.json');
const OUT_JSON = path.join(ROOT, 'titles', 'intros.json');
const OUT_CSV = path.join(ROOT, 'titles', 'intros.csv');
const FS_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const limit = Number(opt('--limit', '0')) || 0;
const delay = Number(opt('--delay', '5000'));
const refresh = args.includes('--refresh');
const mergeOnly = args.includes('--merge-only');
const toS = args.includes('--keep-hant') ? null : OpenCC.Converter({ from: 'tw', to: 'cn' });
const onlyQ = opt('--q', '');

/* ---------- csv ---------- */

function parseCsv(text) {
	const rows = [];
	let row = [], field = '', quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') { row.push(field); field = ''; }
		else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
		else if (c !== '\r') field += c;
	}
	if (field || row.length) { row.push(field); rows.push(row); }
	return rows.filter(r => r.some(v => v !== ''));
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/* ---------- html ---------- */

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', deg: '°' };

function clean(html) {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e) => {
			if (e[0] === '#') { const hex = e[1] === 'x' || e[1] === 'X'; return String.fromCodePoint(parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10)); }
			return ENT[e.toLowerCase()] ?? m;
		})
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.replace(/^[\s　]+|[\s　]+$/g, '');
}

const norm = s => String(s ?? '').replace(/[\s\-–—_·．.、,，:：;；!！?？"'“”‘’()（）[\]【】《》〈〉/\\|+*~]/g, '').toLowerCase();

/* ---------- flaresolverr ---------- */

let session = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fsrRaw(payload) {
	const res = await fetch(FS_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ maxTimeout: 60000, ...payload }),
		signal: AbortSignal.timeout(120000),
	});
	const j = await res.json().catch(() => null);
	if (!j) throw new Error(`${payload.cmd}: bad FlareSolverr reply (${res.status})`);
	if (j.status !== 'ok') throw new Error(`${payload.cmd}: ${j.message || j.status}`);
	return j;
}

async function startSession() {
	if (session) return;
	try { session = (await fsrRaw({ cmd: 'sessions.create' })).session; console.log(`flaresolverr session ${session}`); }
	catch (e) { console.warn(`flaresolverr session unavailable (${e.message}); using one-shot requests`); }
}

// books.com.tw serves an empty shell once it decides you are a bot
const looksBlocked = html => !html.includes('search_results') && !html.includes('prod-itemlist') && !html.includes('IntroP');

async function get(url, tries = 3) {
	for (let i = 0; ; i++) {
		const s = await fsrRaw({ cmd: 'request.get', ...(session ? { session } : {}), url }).then(j => j.solution);
		if (s.status !== 200) throw new Error(`HTTP ${s.status} for ${url}`);
		if (!looksBlocked(s.response) || i >= tries) return s.response;
		const wait = 60000 * (i + 1);
		console.warn(`  throttled by books.com.tw, sleeping ${wait / 1000}s`);
		await sleep(wait);
	}
}

/* ---------- books.com.tw ---------- */

function hits(html) {
	const count = Number((html.match(/搜尋結果共\s*<span>\s*(\d+)\s*<\/span>/) ?? [])[1] ?? 0);
	const out = [];
	const re = /id="prod-itemlist-(\d+)"[\s\S]{0,800}?title="([^"]{0,120})"/g;
	for (let m; (m = re.exec(html)); ) out.push({ id: m[1], name: clean(m[2]) });
	return { count, out };
}

function volIntro(html) {
	const at = html.indexOf('<a name="IntroP');
	if (at < 0) return null;
	let end = html.indexOf('<a name="', at + 10);
	if (end < 0) end = Math.min(html.length, at + 20000);
	const name = clean((html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/) ?? [])[1] ?? '');
	const text = clean(html.slice(at, end)).replace(/^[^\n]*內容簡介\s*/, '').replace(/\s*more\s*$/i, '');
	return text.length >= 30 ? { name, text } : null;
}

// "落第賢者的學院無雙_3" / "…(01)" / "…（上）" -> the series stem to search for
function baseTitle(t) {
	return clean(String(t)
		.replace(/[_－-]?\s*[（(]?\s*(?:第)?\s*\d{1,2}\s*[)）]?\s*$/g, '')
		.replace(/[_－-]\s*(?:全|上|下|前|後)\s*$/g, '')
		.replace(/[（(]\s*(?:全|上|下|前|後)\s*[)）]\s*$/g, '')
		.replace(/[_－-]+$/g, ''));
}

async function search(q) {
	const url = `https://search.books.com.tw/search/query/key/${encodeURIComponent(q)}/cat/all`;
	const { count, out } = hits(await get(url));
	return { url, count, out };
}

// every volume of this title's series, plus each volume's blurb
async function series(rec, vols) {
	const base = baseTitle(rec.title);
	let r = await search(base);
	if (!r.out.length && rec.isbn) r = await search(rec.isbn);
	const a = norm(base).slice(0, 6);
	const siblings = r.out.filter(h => !a || norm(h.name).includes(a));
	const list = siblings.length ? siblings : r.out.slice(0, 1);
	const out = [];
	for (const h of list) {
		const v = vols[h.id] ??= {};
		if (!v.text || refresh) {
			await sleep(delay);
			const got = volIntro(await get(`https://www.books.com.tw/products/${h.id}`));
			if (got) Object.assign(v, { url: `https://www.books.com.tw/products/${h.id}`, name: h.name || got.name, text: got.text, at: new Date().toISOString() });
			else v.error = 'no 內容簡介';
			fs.writeFileSync(VOLS, JSON.stringify(vols, null, 1));
		}
		if (v.text) out.push({ id: h.id, name: v.name || h.name, url: v.url, text: toS ? toS(v.text) : v.text });
	}
	if (!out.length) throw new Error(`no volume with 內容簡介 (searched "${base}", ${r.count} hits)`);
	return { base, searchUrl: r.url, volumes: out };
}

/* ---------- main ---------- */

async function main() {
	const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
	const head = rows.shift();
	const recs = rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
	const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
	const vols = fs.existsSync(VOLS) ? JSON.parse(fs.readFileSync(VOLS, 'utf8')) : {};
	const intros = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')) : {};

	const todo = onlyQ
		? [{ title: onlyQ, isbn: '' }]
		: recs.filter(r => refresh || !cache[r.title]?.volumes?.length).slice(0, limit > 0 ? limit : undefined);

	if (!mergeOnly) await startSession();
	let ok = 0, miss = 0, total = 0;
	for (const rec of (mergeOnly ? [] : todo)) {
		try {
			const got = await series(rec, vols);
			cache[rec.title] = { ...got, at: new Date().toISOString() };
			ok++; total += got.volumes.length;
			console.log(`OK   ${rec.title} — ${got.volumes.length} volumes\n       ${got.volumes.map(v => v.name).join('\n       ')}`);
		} catch (e) {
			miss++;
			cache[rec.title] = { error: e.message, at: new Date().toISOString() };
			console.log(`FAIL ${rec.title} — ${e.message}`);
		}
		fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
		await sleep(delay);
	}

	// merge: keep any existing primary blurb, always add the per-volume list
	let addedVol = 0;
	for (const [title, v] of Object.entries(cache)) {
		if (!v.volumes?.length) continue;
		const cur = intros[title] ?? {};
		cur.volumes = v.volumes;
		if (!cur.intro) { cur.intro = v.volumes[0].text; cur.lang = toS ? 'zh-Hans' : 'zh-Hant'; cur.source = 'books_tw'; cur.url = v.volumes[0].url; }
		const rec = recs.find(r => r.title === title) ?? {};
		cur.isbn = rec.isbn ?? cur.isbn ?? '';
		intros[title] = cur;
		addedVol += v.volumes.length;
	}

	// any surviving blurb that is Chinese (no kana) gets converted to Simplified too
	let converted = 0;
	for (const v of Object.values(intros)) {
		if (!v.intro || v.lang === 'zh-Hans' || !toS || /[\u3040-\u30ff]/.test(v.intro)) continue;
		v.intro = toS(v.intro); v.lang = 'zh-Hans'; converted++;
	}
	fs.writeFileSync(OUT_JSON, JSON.stringify(intros, null, 1));

	const csv = [['title', 'isbn', 'source', 'lang', 'volume', 'url', 'intro']];
	for (const [title, v] of Object.entries(intros)) {
		const rec = recs.find(r => r.title === title) ?? {};
		if (v.volumes?.length) for (const vol of v.volumes) csv.push([title, rec.isbn ?? '', 'books_tw', v.lang ?? '', vol.name, vol.url, vol.text]);
		else if (v.intro) csv.push([title, rec.isbn ?? v.isbn ?? '', v.source ?? '', v.lang ?? '', '', v.url ?? '', v.intro]);
	}
	fs.writeFileSync(OUT_CSV, csv.map(r => r.map(csvCell).join(',')).join('\n') + '\n');

	const withIntro = Object.values(intros).filter(v => v.intro).length;
	if (!Object.keys(intros).length && !addedVol) {
		console.error('refusing to write: no cached blurbs found (titles/books_tw*.json and titles/intros.json are both empty/absent)');
		return;
	}
	console.log(`\nseries: ${ok} ok, ${miss} failed, ${total} volumes this run | intros.json: ${Object.keys(intros).length} entries, ${withIntro} with intro, ${addedVol} volume blurbs (+${converted} converted to Simplified)`);
	if (session) { try { await fsrRaw({ cmd: 'sessions.destroy', session }); } catch {} }
}

await main();
