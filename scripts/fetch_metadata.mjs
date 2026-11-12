#!/usr/bin/env node
// Resolve the Japanese original title, author and illustrator of every book in
// output/ via Bangumi (title search), with CiNii Books and openBD as fallbacks.
//
// usage: node scripts/fetch_metadata.mjs [--limit N] [--only text] [--refresh] [--out file]
import fs from 'node:fs';
import path from 'node:path';
import * as OpenCC from 'opencc-js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const CACHE_FILE = path.join(ROOT, 'titles', 'metadata_cache.json');
const UA = 'playwright_ritdon-metadata/1.0';

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : def;
};
const limit = Number(opt('--limit', '0')) || 0;
const only = opt('--only', '');
const refresh = args.includes('--refresh');
const csvFile = opt('--out', path.join(ROOT, 'titles', 'metadata.csv'));

const tw2cn = OpenCC.Converter({ from: 'tw', to: 'cn' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const norm = s => tw2cn(String(s ?? ''))
	.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
	.replace(/[\s_\-–—・·:：!！?？,，.。、;；'"“”‘’()（）\[\]【】「」『』<>《》/\\]/g, '')
	.toLowerCase();

const bigrams = s => Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));

function dice(a, b) {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const pool = new Map();
	for (const g of bigrams(a)) pool.set(g, (pool.get(g) ?? 0) + 1);
	let hit = 0;
	for (const g of bigrams(b)) {
		const n = pool.get(g);
		if (n) {
			hit++;
			pool.set(g, n - 1);
		}
	}
	return (2 * hit) / (bigrams(a).length + bigrams(b).length);
}

function score(title, cand) {
	if (!cand) return 0;
	if (title === cand) return 1;
	if (cand.length < 3) return 0.4;
	const ratio = Math.min(title.length, cand.length) / Math.max(title.length, cand.length);
	if (ratio >= 0.6 && (cand.includes(title) || title.includes(cand))) return 0.8 + 0.15 * ratio;
	return 0.75 * dice(title, cand);
}

let lastBgm = 0;
async function bgm(url, init = {}) {
	const wait = lastBgm + 1100 - Date.now();
	if (wait > 0) await sleep(wait);
	lastBgm = Date.now();
	const res = await fetch(url, {
		...init,
		headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
	});
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status}`);
	return res.json();
}

async function bgmSearch(keyword) {
	const json = await bgm('https://api.bgm.tv/v0/search/subjects', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ keyword, filter: { type: [1] } }),
	});
	return json.data ?? [];
}

const infoValue = (infobox, keys) => {
	for (const e of infobox ?? []) {
		if (keys.includes(e.key)) return String(e.value ?? '').trim();
	}
	return '';
};

let lastOther = 0;
async function otherJson(url) {
	const wait = lastOther + 400 - Date.now();
	if (wait > 0) await sleep(wait);
	lastOther = Date.now();
	const res = await fetch(url, { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	return res.json();
}

async function cinii(title) {
	const url = new URL('https://ci.nii.ac.jp/books/opensearch/search');
	url.searchParams.set('title', title);
	url.searchParams.set('format', 'json');
	url.searchParams.set('count', '5');
	const items = (await otherJson(url))['@graph']?.[0]?.items ?? [];
	const want = norm(title);
	let best = null;
	for (const item of items) {
		const creator = String(item['dc:creator'] ?? '');
		if (/監督|脚本|演出|翻訳|訳者|作画|漫画|イラスト/.test(creator)) continue;
		const s = score(want, norm(item.title ?? '')) + (/97[89]\d{10}/.test(JSON.stringify(item)) ? 0.1 : 0);
		if (!best || s > best.s) best = { s, item, creator };
	}
	if (!best) return null;
	const isbn = (JSON.stringify(best.item).match(/97[89]\d{10}/) ?? [''])[0];
	const creator = best.creator.replace(/\[.*?\]|著$|編$|編集$/g, '').trim();
	return { isbn, creator };
}

async function openbd(isbn) {
	if (!/^97[89]\d{10}$/.test(isbn)) return [];
	const [rec] = await otherJson(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
	const people = rec?.onix?.DescriptiveDetail?.Contributor ?? [];
	return people
		.map(p => String(p.PersonName?.content ?? '').replace(/,\s*/g, '').trim())
		.filter(Boolean);
}

// Douban has no public API. The classic search page lists subject links, and
// a subject page carries the original (Japanese) title for translated editions.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KANA = /[\u3040-\u30ff]/;

let lastDouban = 0;
async function doubanHtml(url) {
	const wait = lastDouban + 2200 - Date.now();
	if (wait > 0) await sleep(wait);
	lastDouban = Date.now();
	const res = await fetch(url, {
		headers: { 'User-Agent': BROWSER_UA, Referer: 'https://book.douban.com/' },
	});
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	return res.text();
}

const decodeEntities = s => s
	.replace(/&quot;/g, '"')
	.replace(/&#39;/g, "'")
	.replace(/&amp;/g, '&')
	.replace(/&lt;/g, '<')
	.replace(/&gt;/g, '>');

async function doubanSearch(keyword) {
	const html = await doubanHtml(`https://www.douban.com/search?cat=1001&q=${encodeURIComponent(keyword)}`);
	const out = [];
	const re = /<a\b[^>]*?sid:\s*(\d+)[^>]*?title="([^"]*)"[^>]*>/g;
	let m;
	while ((m = re.exec(html))) out.push({ id: m[1], title: decodeEntities(m[2]).trim() });
	return out;
}

async function doubanSubject(id) {
	const html = await doubanHtml(`https://book.douban.com/subject/${id}/`);
	const title = decodeEntities((html.match(/<title>([^<]*)<\/title>/) ?? ['', ''])[1])
		.replace(/\s*\(豆瓣\)\s*$/, '')
		.trim();
	const at = html.indexOf('id="info"');
	const block = at < 0 ? '' : html.slice(at, html.indexOf('</div>', at));
	const info = {};
	const re = /<span class="pl">\s*([^<:：]+?)\s*[:：]?\s*<\/span>\s*([\s\S]*?)(?:<br\s*\/?>|<\/span>)/g;
	let m;
	while ((m = re.exec(block))) {
		const v = m[2]
			.replace(/<[^>]+>/g, '')
			.replace(/&nbsp;/g, ' ')
			.replace(/^\s*[:：]\s*/, '')
			.replace(/\s+/g, ' ')
			.trim();
		if (v) info[m[1].trim()] = v;
	}
	return {
		title,
		original: info['原作名'] ?? '',
		author: info['作者'] ?? '',
		series: info['丛书'] ?? '',
		illustrator: info['绘者'] ?? info['繪者'] ?? info['插画'] ?? info['插畫'] ?? '',
		isbn: (String(info['ISBN'] ?? '').match(/97[89]\d{10}/) ?? [''])[0],
	};
}

const doubanRow = (title, cand, info, title_ja, author, isbn, sources) => ({
	status: 'ok',
	title,
	title_ja,
	author,
	illustrator: info.illustrator,
	isbn,
	confidence: cand.s >= 0.98 ? 'high' : cand.s >= 0.8 ? 'medium' : 'low',
	score: Number(cand.s.toFixed(3)),
	bangumi_id: '',
	douban_id: cand.id,
	source: sources.join('+'),
});

async function doubanResolve(title, wants, keyVariants) {
	const seen = new Set();
	const results = [];
	const add = rows => {
		for (const r of rows) {
			if (seen.has(r.id)) continue;
			seen.add(r.id);
			results.push({ ...r, s: Math.max(...wants.map(w => score(w, norm(r.title)))), kana: KANA.test(r.title) });
		}
	};
	for (const kw of keyVariants) {
		add(await doubanSearch(kw));
		if (results.some(c => c.s >= 0.98)) break;
	}
	// an empty result set usually means a soft block, not a missing book
	if (!results.length) {
		await sleep(6000);
		add(await doubanSearch(keyVariants[0]));
	}

	const vol = s => {
		const m = norm(s).match(/(\d+)(?!.*\d)/);
		return m ? String(Number(m[1])) : '';
	};
	const ranked = results.filter(c => c.s >= 0.6).sort((a, b) => b.s - a.s);

	// translated edition: its 原作名 is the original title
	for (const cand of ranked.filter(c => !c.kana).slice(0, 5)) {
		const info = await doubanSubject(cand.id);
		if (!info.original) continue;
		const sources = ['douban'];
		let author = '';
		let isbn = info.isbn;
		const c = await cinii(info.original).catch(() => null);
		if (c?.creator) {
			author = c.creator;
			sources.push('cinii');
		}
		isbn = isbn || c?.isbn || '';
		if (!author && isbn) {
			const people = await openbd(isbn).catch(() => []);
			if (people.length) {
				author = people.join(' / ');
				sources.push('openbd');
			}
		}
		return doubanRow(title, cand, info, info.original, author, isbn, sources);
	}

	// no 原作名: the Japanese edition is listed next to the Chinese one; titles
	// differ (副/准, 的/の, 測/察 ...) but the volume suffix matches
	const v = vol(title);
	const jp = results
		.filter(c => c.kana && c.s >= 0.35 && (vol(c.title) === v || vol(c.title) === '' || v === ''))
		.sort((a, b) => Number(vol(b.title) === v) - Number(vol(a.title) === v) || b.s - a.s)
		.slice(0, 3);
	const jpRow = async (cand, info) => {
		const sources = ['douban'];
		let author = '';
		const c = await cinii(info.title).catch(() => null);
		if (c?.creator) {
			author = c.creator;
			sources.push('cinii');
		}
		return doubanRow(title, cand, info, info.title, author || info.author, info.isbn, sources);
	};

	// manga companion volumes share the title; use one only if no prose edition
	let backup = null;
	for (const cand of jp) {
		const info = await doubanSubject(cand.id);
		if (!info.author && !info.isbn) continue;
		const row = await jpRow(cand, info);
		if (!/コミックス|原案/.test(`${info.series} ${info.author}`)) return row;
		backup = backup ?? row;
	}
	return backup;
}

async function resolve(title) {
	const keyword = title.replace(/_/g, ' ').trim();
	const baseOf = s => s
		.replace(/[（(【\[「『][^）)】\]」』]*[）)】\]」』]/g, ' ')
		.replace(/[\s_]*\d+\s*$/, ' ')
		.trim();
	const stripOf = s => s.replace(/^(?:(?:小說|小说|動畫|动画|漫畫|漫画)[\s_.．・:：]*)+/, '');
	const base = baseOf(title);
	const preferNovel = /^(?:小說|小说)/.test(title);
	const cutAtDigit = s => s.replace(/([\u4e00-\u9fff]{4,})[\d０-９].*$/, '$1');
	// leading title without the "(01) subtitle" part
	const headOf = s => s.split(/[（(【\[「『]/)[0].trim();
	const wants = [...new Set([
		norm(title),
		norm(base || title),
		norm(stripOf(title)),
		norm(stripOf(base || title)),
		norm(cutAtDigit(title)),
		norm(cutAtDigit(base || title)),
		norm(headOf(title)),
		norm(cutAtDigit(headOf(title))),
	])].filter(Boolean);
	const keyVariants = [...new Set([
		keyword,
		tw2cn(keyword),
		stripOf(keyword),
		tw2cn(stripOf(keyword)),
		baseOf(keyword),
		tw2cn(baseOf(keyword)),
		cutAtDigit(keyword),
		tw2cn(cutAtDigit(keyword)),
		headOf(keyword),
		tw2cn(headOf(keyword)),
	].map(s => s.trim()).filter(Boolean))];
	const seen = new Set();
	let best = null;

	for (const kw of keyVariants) {
		for (const r of await bgmSearch(kw)) {
			if (seen.has(r.id)) continue;
			seen.add(r.id);
			if (/[\uAC00-\uD7AF]/.test(r.name ?? '')) continue;
			let s = Math.max(...wants.flatMap(w => [score(w, norm(r.name_cn)), score(w, norm(r.name))]));
			if (preferNovel && !/小説|小说/.test(`${r.name ?? ''}${r.name_cn ?? ''}`)) s *= 0.85;
			if (!best || s > best.score) best = { id: r.id, score: s, name: r.name ?? '', name_cn: r.name_cn ?? '' };
		}
		if (best && best.score >= 0.98) break;
	}

	if (!best || best.score < 0.55) {
		const alt = await doubanResolve(title, wants, keyVariants).catch(e => {
			console.error(`douban: ${title}: ${e.message}`);
			return null;
		});
		if (alt) return alt;
		return { status: 'not-found', title, best };
	}

	const detail = await bgm(`https://api.bgm.tv/v0/subjects/${best.id}`);
	const infobox = detail.infobox;
	let title_ja = detail.name || best.name;
	let author = infoValue(infobox, ['作者', '原作']);
	let illustrator = infoValue(infobox, ['插图', '插畫', '插画', 'イラスト', '封面绘制']);
	let isbn = (infoValue(infobox, ['ISBN']).match(/97[89]\d{10}/) ?? [''])[0];
	const sources = ['bangumi'];

	if ((!author || !isbn) && title_ja) {
		const c = await cinii(title_ja).catch(() => null);
		if (c) {
			if (!author && c.creator) {
				author = c.creator;
				sources.push('cinii');
			}
			if (!isbn && c.isbn) isbn = c.isbn;
		}
	}
	if (!author && isbn) {
		const people = await openbd(isbn).catch(() => []);
		if (people.length) {
			author = people.join(' / ');
			sources.push('openbd');
		}
	}

	const confidence = best.score >= 0.98 ? 'high' : best.score >= 0.8 ? 'medium' : 'low';
	return {
		status: 'ok',
		title,
		title_ja,
		author,
		illustrator,
		isbn,
		confidence,
		score: Number(best.score.toFixed(3)),
		bangumi_id: best.id,
		douban_id: '',
		source: sources.join('+'),
	};
}

function books() {
	if (!fs.existsSync(OUTPUT_DIR)) return [];
	return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
		.filter(d => d.isDirectory() && fs.existsSync(path.join(OUTPUT_DIR, d.name, 'temp.md')))
		.map(d => d.name)
		.filter(t => !only || t.includes(only))
		.sort((a, b) => a.localeCompare(b, 'zh'));
}

const quote = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const COLUMNS = ['title', 'title_ja', 'author', 'illustrator', 'isbn', 'confidence', 'source', 'bangumi_id', 'douban_id', 'score'];

function writeCsv(rows, file) {
	const lines = [COLUMNS.join(',')];
	for (const r of rows) lines.push(COLUMNS.map(c => quote(r[c])).join(','));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function main() {
	fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
	const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
	const titles = books();
	const todo = (limit ? titles.slice(0, limit) : titles).filter(t => refresh || !cache[t]);
	const rows = [];
	const total = titles.length;

	for (const title of titles) {
		if (todo.includes(title)) continue;
		if (cache[title]?.status === 'ok') rows.push(cache[title]);
	}

	let n = 0;
	for (const title of todo) {
		n++;
		try {
			const r = await resolve(title);
			cache[title] = r;
			fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, '\t'));
			rows.push(r);
			if (r.status === 'ok') {
				console.log(`[${n}/${todo.length}] ${title} -> ${r.title_ja} (${r.confidence} ${r.score}) ${r.author}`);
			} else {
				console.log(`[${n}/${todo.length}] ${title} -> NOT FOUND`);
			}
		} catch (e) {
			console.error(`[${n}/${todo.length}] ${title} -> ERROR ${e.message}`);
		}
	}

	const ok = rows.filter(r => r.status === 'ok');
	ok.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
	writeCsv(ok, csvFile);
	const found = ok.length;
	const high = ok.filter(r => r.confidence === 'high').length;
	console.log(`\n${found}/${total} resolved (${high} high confidence) -> ${csvFile}`);
}

main().catch(e => {
	console.error(e);
	process.exitCode = 1;
});
