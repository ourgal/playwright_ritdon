#!/usr/bin/env node
// Shared volume-label parsing for scripts/fetch_wenku8_volumes.mjs and
// scripts/find_wenku8_ids.mjs.
//
// The two sites write a volume in completely different ways:
//   ritdon  "文學少女_07", "...這件事11.5", "奇諾の旅_XXⅢ", "小書痴的下剋上：第三部_領主的養女Ⅱ"
//   wenku8  "第一卷 渴望死亡的小丑", "第7卷", "11.5", "Vol.1 副标题"
// Both sides are reduced to a canonical short decimal string ("7", "11.5") so
// they can be compared, plus the residual subtitle for the ambiguous cases.
//
// No dependencies on purpose: the offline matcher imports this module and must
// stay runnable without patchright/chromium.

const ROMAN_UNICODE = {
	'Ⅰ': 'i', 'Ⅱ': 'ii', 'Ⅲ': 'iii', 'Ⅳ': 'iv', 'Ⅴ': 'v', 'Ⅵ': 'vi', 'Ⅶ': 'vii', 'Ⅷ': 'viii', 'Ⅸ': 'ix', 'Ⅹ': 'x',
	'ⅰ': 'i', 'ⅱ': 'ii', 'ⅲ': 'iii', 'ⅳ': 'iv', 'ⅴ': 'v', 'ⅵ': 'vi', 'ⅶ': 'vii', 'ⅷ': 'viii', 'ⅸ': 'ix', 'ⅹ': 'x',
};
const ROMAN_UNICODE_CLASS = 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ';
const ROMAN_VALUE = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const VOL_UNITS = '卷冊册集部篇話话';

export const toHalf = s => String(s ?? '')
	.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
	.replace(/．/g, '.')
	.replace(/[　\xa0]/g, ' ');

function cjkToInt(text) {
	let total = 0;
	let cur = 0;
	for (const ch of String(text)) {
		if (ch in DIGIT) cur = DIGIT[ch];
		else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
		else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
		else return null;
	}
	return total + cur;
}

function romanToInt(text) {
	const s = String(text).toLowerCase();
	let total = 0;
	for (let i = 0; i < s.length; i++) {
		const v = ROMAN_VALUE[s[i]];
		if (!v) return null;
		total += v < (ROMAN_VALUE[s[i + 1]] ?? 0) ? -v : v;
	}
	return total || null;
}

// "07" -> "7", "11.50" -> "11.5", "０９" -> "9"; null when it is not a number.
const trimNum = s => {
	const [i, d] = s.split('.');
	const head = String(Number(i));
	if (d === undefined) return head;
	const tail = d.replace(/0+$/, '');
	return tail ? head + '.' + tail : head;
};

export function canonVolume(token) {
	const t = toHalf(token).replace(/\s+/g, '');
	if (!t) return null;
	if (/^[0-9]+(?:\.[0-9]+)?$/.test(t)) return trimNum(t);
	if (new RegExp('^[' + ROMAN_UNICODE_CLASS + ']+$').test(t)) {
		const n = romanToInt([...t].map(c => ROMAN_UNICODE[c] ?? c).join(''));
		return n ? String(n) : null;
	}
	if (/^[ivxlcdm]+$/i.test(t)) {
		const n = romanToInt(t);
		return n ? String(n) : null;
	}
	const n = cjkToInt(t);
	return n ? String(n) : null;
}

// A wenku8 volume label, e.g. "第一卷 渴望死亡的小丑" / "第7卷" / "Vol.1 上".
// Returns the canonical volume number, the unit word and the subtitle left
// after removing the label and the series name.
export function parseVolumeLabel(text, seriesTitle = '') {
	const t = toHalf(text).replace(/\s+/g, ' ').trim();
	let num = null;
	let unit = '';
	let rest = t;
	let m = t.match(new RegExp('第\\s*([0-9]+(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百]+)\\s*([' + VOL_UNITS + '])'));
	if (m) {
		num = canonVolume(m[1]);
		unit = m[2];
		rest = t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length);
	}
	if (num == null) {
		// "01 副标题" / "11.5" / "Vol.1 副标题" - a leading number is the volume.
		m = t.match(/^(?:vol\.?\s*)?([0-9]+(?:\.[0-9]+)?)(?![0-9.])/i);
		if (m) {
			num = canonVolume(m[1]);
			unit = 'vol';
			rest = t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length);
		}
	}
	if (num == null) {
		// "Ⅱ 下" - a standalone leading roman numeral, never part of a word.
		m = t.match(new RegExp('^(?:vol\\.?\\s*)?([' + ROMAN_UNICODE_CLASS + ']+)(?=$|[\\s_（(【\\[])'));
		if (!m) m = t.match(/^(?:vol\.?\s*)?([ivxlcdm]+)(?=$|[\s_（(【\[])/i);
		if (m) {
			num = canonVolume(m[1]);
			unit = 'roman';
			rest = t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length);
		}
	}
	let subtitle = rest.replace(/\s+/g, ' ').trim();
	const st = toHalf(seriesTitle).replace(/\s+/g, ' ').trim();
	if (st && subtitle.startsWith(st)) subtitle = subtitle.slice(st.length);
	subtitle = subtitle.replace(/^[\s_\-–—:：·・、,，.。]+|[\s_\-–—:：·・、,，.。]+$/g, '');
	return { num, unit, subtitle };
}

// The volume marker ritdon appends to a title. This mirrors the stripVol()
// regex order in find_wenku8_ids.mjs on purpose: whatever that strips is what
// this reports, so the series name is never truncated differently.
const RITDON_TRAILING = [
	// Trailing punctuation is tolerated: "TIGER×DRAGON10!" is volume 10.
	{ re: /[\s_]*[（(【\[]?\s*([0-9０-９]+(?:\.[0-9０-９]+)?)\s*[）)】\]]?[!！?？~～…\s_]*$/, unit: 'vol' },
	{ re: new RegExp('[\\s_]*([\\u2160-\\u217f]+)\\s*$'), unit: 'roman' },
	// Only a standalone token: "CROSS＋WIZARD" must not read as vol 500.
	{ re: /(?<=[\s_　]|[^\x00-\x7f])([ivxlcdm]+)\s*$/i, unit: 'roman' },
	{ re: /[\s_]*第\s*([零〇一二三四五六七八九十百\d]+)\s*([卷冊册集部篇話话])\s*$/i, unit: 'cjk' },
];

export function ritdonVolume(raw) {
	const t = String(raw ?? '');
	for (const { re, unit } of RITDON_TRAILING) {
		const m = re.exec(t);
		if (!m) continue;
		const num = canonVolume(m[1]);
		if (num == null) continue;
		return { num, unit, base: t.slice(0, m.index) };
	}
	return { num: null, unit: '', base: t };
}
