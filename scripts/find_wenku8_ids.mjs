#!/usr/bin/env node
// Match the ritdon library titles (titles/*.txt) against the wenku8.net catalog
// index (titles/wenku8_net_index.json) and report the wenku8 book id for each.
//
// The two sites use different title conventions: ritdon titles are mostly
// Traditional Chinese, use "_" for spaces and carry volume numbers / subtitles
// (e.g. "關於我在無意間被隔壁的天使變成廢柴這件事11.5"); wenku8 titles are clean
// Simplified Chinese series names (e.g. "关于我在无意间被隔壁的天使变成废柴这件事").
// So we normalise both sides (TW->CN, fullwidth->halfwidth, strip punctuation
// and underscores), generate several stripped variants of each ritdon title,
// then do an exact lookup first and a bigram-Dice fuzzy fallback second.
//
// This is a purely offline script: it only needs the index + title text files,
// no credentials and no browser.
//
// usage: node scripts/find_wenku8_ids.mjs [options]
//   --index <file>      wenku8 id index (default titles/wenku8_net_index.json)
//   --titles <files>    comma-separated ritdon title files
//                       (default titles/titles.txt,titles/titles_zht.txt,titles/titles_other.txt;
//                        titles.txt is already the superset of the other two)
//   --out <file>        result CSV (default titles/wenku8_ids.csv)
//   --min-score <0..1>  accept a fuzzy match at/above this (default 0.55)
//   --limit N           only process the first N titles (debug)
//   --show N            sample rows printed for fuzzy / not-found (default 12)
import fs from 'node:fs';
import path from 'node:path';
import * as OpenCC from 'opencc-js';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : def;
};
const num = (name, def) => {
	const v = Number(opt(name, def));
	return Number.isFinite(v) ? v : def;
};

const indexFile = path.resolve(ROOT, opt('--index', 'titles/wenku8_net_index.json'));
const outFile = path.resolve(ROOT, opt('--out', 'titles/wenku8_ids.csv'));
const titleFiles = opt('--titles', 'titles/titles.txt,titles/titles_zht.txt,titles/titles_other.txt')
	.split(',').map(s => s.trim()).filter(Boolean).map(f => path.resolve(ROOT, f));
const minScore = Math.min(1, Math.max(0, num('--min-score', 0.55)));
const limit = num('--limit', 0) || 0;
const show = num('--show', 12);

const tw2cn = OpenCC.Converter({ from: 'tw', to: 'cn' });
// Roman numerals are category Nl (letter-number), so \p{P}/\p{S} leaves them
// intact. wenku8 writes "II / I" where ritdon writes "Ⅱ / Ⅰ"; fold them to the
// same ASCII letters so the two spellings match.
const ROMAN = {
	'Ⅰ': 'i', 'Ⅱ': 'ii', 'Ⅲ': 'iii', 'Ⅳ': 'iv', 'Ⅴ': 'v', 'Ⅵ': 'vi', 'Ⅶ': 'vii', 'Ⅷ': 'viii', 'Ⅸ': 'ix', 'Ⅹ': 'x',
	'ⅰ': 'i', 'ⅱ': 'ii', 'ⅲ': 'iii', 'ⅳ': 'iv', 'ⅴ': 'v', 'ⅵ': 'vi', 'ⅶ': 'vii', 'ⅷ': 'viii', 'ⅸ': 'ix', 'ⅹ': 'x',
};
const ROMAN_RE = /[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]/g;

// Strip every punctuation mark and symbol (all CJK brackets 〈〉「」【】［］,
// dashes, middle dots, fullwidth forms, ...) plus whitespace. Both sides use
// the same norm, so removing them symmetrically is safe and lets a noisy
// ritdon title contain the clean wenku8 title as a substring - which the
// fuzzy scorer rewards via its containment bonus.
const norm = s => tw2cn(String(s ?? ''))
	.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
	.replace(ROMAN_RE, c => ROMAN[c])
	.toLowerCase()
	.replace(/[\p{P}\p{S}\s]/gu, '');

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

// ritdon title -> several cleaned forms, from most specific to most general.
const stripPrefix = s => s.replace(/^(?:(?:輕小說|轻小说|小說|小说|動畫|动画|漫畫|漫画|文庫|文库|新裝版|新装版|完全版|限定版|特裝版|特装版)[\s_.．・:：\-]*)+/i, '');
const stripEdition = s => s.replace(/(?:新裝版|新装版|完全版|限定版|特裝版|特装版|文庫版|文库版|豪華版|豪华版|新訳版|新译版)/gi, '');
const stripVol = s => s
	.replace(/[\s_]*[（(【\[]?\d+(?:\.\d+)?[）)】\]]?\s*$/, '')
	.replace(/[\s_]*[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]+\s*$/, '')
	.replace(/[\s_]*第[零〇一二三四五六七八九十百\d]+[卷冊册集部篇話话]\s*$/i, '')
	.trim();
const head = s => s.split(/[（(【\[「『〈]/)[0].trim();
const cutVolWord = s => s.split(/[\s_]*第[零〇一二三四五六七八九十百\d]+[卷冊册集部篇話话]/)[0].trim();
const cutAtDigit = s => s.replace(/([\u4e00-\u9fff]{4,})\d[\s\S]*$/, '$1');
const cutAtFirstDigit = s => s.replace(/\d[\s\S]*$/, ''); // "系列-10.副標" -> "系列"
// A Roman numeral in the middle is usually a volume marker: "銃皇…法夫納Ⅱ_無瑕之緋".
const cutAtRoman = s => s.split(ROMAN_RE)[0].trim();
// ritdon often appends the volume subtitle after an underscore while wenku8
// stores only the series name: "才女的侍從_在滿是…大小姐_9" -> "才女的侍從".
// Keep it as a last-resort variant, and only for a substantial CJK-heavy head.
const firstSegment = s => (s.includes('_') ? s.split('_')[0] : s);
// ritdon appends a ～-delimited subtitle while wenku8 has only the main title:
// "軍人少女，要潛入皇立魔法學校了～女性向遊戲？…～(03)".
const cutAtTilde = s => s.split(/[～~〜]/)[0].trim();
// "×" (a symbol) is stripped by norm, but wenku8 often writes the ASCII letter
// "X" instead ("大小姐X执事"). Try both spellings so neither loses a match.
const withX = s => s.replace(/[×╳✕✖]/g, 'x');
// Likewise "&"/"＆" is stripped as punctuation while wenku8 writes the Chinese
// character "与" ("电波女与青春男"). Decode the stray &amp; entity too.
const withAnd = s => s.replace(/&amp;/gi, '&').replace(/[&＆]/g, '与');
const clean = s => stripVol(stripEdition(stripPrefix(s)));

function variants(raw) {
	const bases = [
		raw,
		stripPrefix(raw),
		stripEdition(raw),
		stripVol(raw),
		stripVol(stripPrefix(raw)),
		clean(raw),
		head(raw),
		head(stripEdition(raw)),
		head(clean(raw)),
		stripVol(head(raw)),
		cutVolWord(raw),
		cutVolWord(clean(raw)),
		cutAtDigit(raw),
		cutAtDigit(clean(raw)),
		cutAtFirstDigit(raw),
		cutAtFirstDigit(clean(raw)),
		cutAtRoman(raw),
		cutAtRoman(clean(raw)),
		// additive: the same title with × -> x (kept last so the original
		// ×-stripped spelling still wins when both happen to be valid keys).
		withX(raw),
		stripVol(withX(raw)),
		clean(withX(raw)),
		head(withX(raw)),
		cutAtFirstDigit(withX(raw)),
		cutAtRoman(withX(raw)),
		// additive: & / ＆ -> 与 (kept last, same as the withX variants).
		withAnd(raw),
		stripVol(withAnd(raw)),
		clean(withAnd(raw)),
		head(withAnd(raw)),
		cutAtFirstDigit(withAnd(raw)),
		cutAtRoman(withAnd(raw)),
		// cut at a ～-delimited subtitle (guarded, kept last).
		...(/[\u4e00-\u9fff]/.test(cutAtTilde(raw)) && norm(cutAtTilde(raw)).length >= 4
			? [cutAtTilde(raw), cutAtTilde(clean(raw))] : []),
	];
	return [...new Set(bases.map(norm).filter(Boolean))];
}

// ---- build the wenku8 lookup ----
// Many wenku8 titles carry a parenthetical alternate name, e.g.
//   "【好消息】我的不起眼未婚妻在家有够可爱(【喜讯】我的土妹子未婚妻…)"
//   "TIGER×DRAGON！(龙与虎)"  /  "我的妹妹哪有这么可爱(我的妹妹不可能那么可爱)"
// That suffix makes the full normalized title ~2x longer than a ritdon title
// that only has the main name, killing both exact and fuzzy matching. So index
// every title under: its full form, the part before the first bracket ("head"),
// the part before the first space (some subtitles are space-separated, e.g.
// "堤亚穆帝国物语 从断头台开始…"), and each parenthetical alt name.
const headOf = t => t.split(/[（(]/)[0];
// Some subtitles are space-separated, others are ～-delimited
// ("小书痴的下克上～为了成为图书管理员不择手段～").
const spaceHeadOf = t => t.split(/[\s～~〜]/)[0];
const altsOf = t => [...t.matchAll(/[（(]([^）)]*)[）)]/g)]
	.map(m => norm(m[1])).filter(s => s.length >= 2);

const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const rows = Object.entries(idx).map(([id, v]) => {
	const title = String(v.title ?? '');
	const n = norm(title);
	const hn = norm(headOf(title));
	// Heads and parenthetical alts are all indexed as keys, including 2-char ones
	// ("便当", "化物语", "弑神者"). Full titles claim their key first, so a generic
	// short alt ("暂定"/"可爱") can never displace a real full-title match.
	const extra = [...new Set([
		...(hn.length >= 2 ? [hn] : []),
		...altsOf(title),
	].filter(Boolean))].filter(f => f !== n);
	return {
		id,
		title,
		library: String(v.library ?? ''),
		url: String(v.url ?? ''),
		n,
		forms: [n, ...extra],
	};
}).filter(r => r.n);
// Full titles claim their key first, so a real full-title match always beats a
// head/alt key collision between same-series entries (e.g. 夏目友人帐 422/1498).
const byNorm = new Map();
for (const r of rows) if (!byNorm.has(r.n)) byNorm.set(r.n, r);
for (const r of rows) for (const f of r.forms.slice(1)) if (!byNorm.has(f)) byNorm.set(f, r);

// Some wenku8 entries append a space-separated subtitle while ritdon has only
// the main name ("堤亚穆帝国物语 从断头台开始…"). Register that CJK head, but
// ONLY unambiguous ones - otherwise "古书堂事件手帖" (3 ids) would be guessed.
// Used exclusively as a last-resort fallback, never as an exact/fuzzy key.
const spaceHeadOwners = new Map();
for (const r of rows) {
	const raw = spaceHeadOf(r.title);
	const sh = /[\u4e00-\u9fff]/.test(raw) ? norm(raw) : '';
	if (sh.length < 4 || sh === r.n) continue;
	if (!spaceHeadOwners.has(sh)) spaceHeadOwners.set(sh, []);
	spaceHeadOwners.get(sh).push(r);
}
const spaceHeadMap = new Map([...spaceHeadOwners]
	.filter(([, v]) => v.length === 1)
	.map(([k, v]) => [k, v[0]]));

// Some wenku8 titles glue a Latin/digit suffix straight onto the CJK main name
// ("绝对双刃absolute duo", "时钟机关之星Clockwork Planet"). The bare CJK prefix
// then has no exact key. Register it, unambiguously and last-resort only.
const cjkHeadOf = n => (n.match(/^[\u4e00-\u9fff]+/) ?? [''])[0];
const cjkHeadOwners = new Map();
for (const r of rows) {
	const h = cjkHeadOf(r.n);
	if (h.length < 4 || h === r.n) continue;
	if (!cjkHeadOwners.has(h)) cjkHeadOwners.set(h, []);
	cjkHeadOwners.get(h).push(r);
}
const cjkHeadMap = new Map([...cjkHeadOwners]
	.filter(([, v]) => v.length === 1)
	.map(([k, v]) => [k, v[0]]));

// Inverted bigram index so fuzzy matching only scores plausible candidates.
const posting = new Map();
rows.forEach((r, i) => {
	for (const g of new Set(bigrams(r.n))) {
		if (!posting.has(g)) posting.set(g, []);
		posting.get(g).push(i);
	}
});

function fuzzyCandidates(queryN) {
	const gs = [...new Set(bigrams(queryN))];
	if (!gs.length) return [];
	const votes = new Map();
	for (const g of gs) {
		const list = posting.get(g);
		if (!list) continue;
		for (const i of list) votes.set(i, (votes.get(i) ?? 0) + 1);
	}
	// A 2-char title has only one bigram, so requiring 2 votes would make it
	// impossible to find any candidate at all.
	const minVotes = gs.length < 2 ? 1 : Math.max(2, Math.ceil(gs.length * 0.3));
	return [...votes.entries()]
		.filter(([, v]) => v >= minVotes)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 400)
		.map(([i]) => i);
}

function matchTitle(raw) {
	const vars = variants(raw);
	// 1) exact (a stripped variant counts, but note how it was found)
	for (const n of vars) {
		const r = byNorm.get(n);
		if (r) return { row: r, s: 1, confidence: 'exact', method: n === norm(raw) ? 'exact' : 'exact-stripped' };
	}
	// 2) fuzzy: collect candidates once, score each against every variant
	const candIds = new Set();
	for (const n of vars) if (n.length >= 2) for (const i of fuzzyCandidates(n)) candIds.add(i);
	let best = null;
	for (const i of candIds) {
		const r = rows[i];
		let s = 0;
		// Score each query variant against all of the index title's forms:
		// a ritdon title using the main name should not be penalised for the
		// wenku8 entry's parenthetical alternate name.
		for (const n of vars) for (const f of r.forms) s = Math.max(s, score(n, f));
		if (!best || s > best.s) best = { row: r, s };
	}
	if (best && best.s >= minScore) {
		const confidence = best.s >= 0.85 ? 'high' : best.s >= 0.7 ? 'medium' : 'low';
		return { row: best.row, s: best.s, confidence, method: 'fuzzy' };
	}
	// 3) last resort only for otherwise-unmatched titles: ritdon appends the
	// volume subtitle after "_" while wenku8 stores just the series name.
	// Keep this OUT of variants() - as an exact-pass variant it would override
	// correct spin-off matches with a generic base-series hit.
	const seg = firstSegment(raw);
	if (seg !== raw && /[\u4e00-\u9fff]/.test(seg) && norm(seg).length >= 4) {
		const r = byNorm.get(norm(seg));
		if (r) return { row: r, s: 1, confidence: 'exact', method: 'first-segment' };
	}
	// 4) wenku8 has a space-separated subtitle, ritdon only the main name.
	// Last-resort only (and unambiguous heads only), so it cannot steal a
	// correctly matched spin-off volume.
	for (const n of vars) {
		if (n.length < 4) continue;
		const r = spaceHeadMap.get(n);
		if (r) return { row: r, s: 1, confidence: 'high', method: 'space-head' };
	}
	// 5) wenku8 glued a Latin/digit suffix onto the CJK main name; ritdon has
	// only the bare name ("絕對雙刃8" -> "绝对双刃absolute duo").
	for (const n of vars) {
		if (n.length < 4) continue;
		const r = cjkHeadMap.get(n);
		if (r) return { row: r, s: 1, confidence: 'high', method: 'cjk-head' };
	}
	// 6) ritdon PREPENDS a Latin/romanized series name while wenku8 has only the
	// Chinese name: "GOBLIN_SLAYER！哥布林殺手(11)", "Sword_Art_Online刀劍神域_19".
	const noLatin = raw.replace(/^[^\u4e00-\u9fff]+/, '');
	if (noLatin !== raw && /^[\u4e00-\u9fff]/.test(noLatin)) {
		for (const s of [noLatin, stripVol(noLatin), clean(noLatin), head(noLatin), cutAtTilde(noLatin), firstSegment(noLatin)]) {
			const n = norm(s);
			if (n.length < 4) continue;
			// byNorm ONLY: the head maps hold generic truncations ("火影忍者",
			// "刀剑神域外传") shared by several sub-series, which would guess
			// the wrong volume. An unmatched title is better than a wrong id.
			const r = byNorm.get(n);
			if (r) return { row: r, s: 1, confidence: 'high', method: 'latin-prefix' };
		}
	}
	// 7) ritdon uses a ：-delimited part marker while wenku8 has only the series
	// name: "小書痴的下剋上：第三部_領主的養女Ⅱ" -> "小书痴的下克上".
	const colonHead = raw.split(/[：:]/)[0];
	const cn = norm(colonHead);
	if (colonHead !== raw && cn.length >= 4) {
		const r = byNorm.get(cn) ?? spaceHeadMap.get(cn);
		if (r) return { row: r, s: 1, confidence: 'high', method: 'colon-head' };
	}
	return { row: null, s: best?.s ?? 0, confidence: '', method: 'none' };
}

// ---- collect ritdon titles ----
const seen = new Set();
const titles = [];
for (const file of titleFiles) {
	if (!fs.existsSync(file)) {
		console.warn(`warning: ${path.relative(ROOT, file)} not found, skipped`);
		continue;
	}
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const t = line.trim();
		if (!t || /^\[No_data\]$/i.test(t) || seen.has(t)) continue;
		seen.add(t);
		titles.push(t);
	}
}
titles.sort((a, b) => a.localeCompare(b, 'zh'));
const todo = limit ? titles.slice(0, limit) : titles;

// ---- run ----
const COLUMNS = ['title', 'wenku8_id', 'wenku8_title', 'library', 'url', 'confidence', 'score', 'method'];
const quote = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const result = [];
const counts = { exact: 0, 'exact-stripped': 0, 'first-segment': 0, 'space-head': 0, 'cjk-head': 0, 'latin-prefix': 0, 'colon-head': 0, high: 0, medium: 0, low: 0, none: 0 };
const fuzzySamples = [];
const notFoundSamples = [];

for (const raw of todo) {
	const m = matchTitle(raw);
	const r = m.row;
	counts[m.method === 'none' ? 'none' : (m.method === 'fuzzy' ? m.confidence : m.method)]++;
	result.push({
		title: raw,
		wenku8_id: r?.id ?? '',
		wenku8_title: r?.title ?? '',
		library: r?.library ?? '',
		url: r?.url ?? '',
		confidence: m.confidence,
		score: r ? Number(m.s.toFixed(3)) : '',
		method: m.method === 'none' ? '' : m.method,
	});
	if (m.method === 'fuzzy' && fuzzySamples.length < show) fuzzySamples.push(`${raw}  ->  ${r.title} [${r.id}] (${m.s.toFixed(2)} ${m.confidence})`);
	if (m.method === 'none' && notFoundSamples.length < show) notFoundSamples.push(raw);
}

const lines = [COLUMNS.join(',')];
for (const row of result) lines.push(COLUMNS.map(c => quote(row[c])).join(','));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join('\n') + '\n');

const matched = result.filter(r => r.wenku8_id !== '').length;
console.log(`titles:  ${todo.length} unique (from ${titleFiles.length} file(s))`);
console.log(`index:   ${rows.length} wenku8 ids`);
console.log(`matched: ${matched}  (exact ${counts.exact}, exact-stripped ${counts['exact-stripped']}, first-segment ${counts['first-segment']}, space-head ${counts['space-head']}, cjk-head ${counts['cjk-head']}, latin-prefix ${counts['latin-prefix']}, colon-head ${counts['colon-head']}, fuzzy ${counts.high + counts.medium + counts.low})`);
console.log(`  fuzzy confidence: high ${counts.high}, medium ${counts.medium}, low ${counts.low}`);
console.log(`not found: ${counts.none}`);
console.log(`-> ${path.relative(ROOT, outFile)}`);
if (fuzzySamples.length) console.log(`\nsample fuzzy matches:\n  ${fuzzySamples.join('\n  ')}`);
if (notFoundSamples.length) console.log(`\nsample not-found:\n  ${notFoundSamples.join('\n  ')}`);
