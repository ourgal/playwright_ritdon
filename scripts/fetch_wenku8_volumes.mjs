#!/usr/bin/env node
// Crawl the per-series volume list from wenku8.net.
//
// titles/wenku8_net_index.json only knows series: one id per 作品, titled after
// its first volume. The volumes of that series are not on the book page
// (/book/<id>.htm) - it only links a chapter index at
// /novel/<type>/<id>/index.htm, where each volume is a table row
//   <td class="vcss" vid="...">第一卷 渴望死亡的小丑</td>
// followed by its chapter cells. This script follows that link and records the
// volume rows so scripts/find_wenku8_ids.mjs can name the volume instead of
// stopping at the series.
//
// Two requests per id (book page + chapter index). Only the ids the matcher
// actually used are crawled by default (titles/wenku8_ids.csv), never the whole
// 4k-entry catalog.
//
// usage: node scripts/fetch_wenku8_volumes.mjs [options]
//   --cookies <file|string>  raw "a=b; c=d", Netscape cookies.txt, or storageState JSON
//                            (else WENKU8_COOKIES from .env)
//   --username / --password  headed login fallback (else WENKU8_USERNAME/WENKU8_PASSWORD)
//   --save-state <file>      write session cookies (default playwright/.auth/wenku8.json)
//   --index <file>           default titles/wenku8_net_index.json (series titles)
//   --from-csv <file>        default titles/wenku8_ids.csv (ids to crawl)
//   --ids <a,b,c>            explicit id list, overrides --from-csv
//   --out <file>             default titles/wenku8_net_volumes.json
//   --concurrency N          parallel browser pages (default 1; the site 429s hard)
//   --delay ms               pause between requests (default 3000, +0-50% jitter)
//                            Each id costs two requests and they are spaced by --delay too.
//   --limit N                only crawl the first N ids (debug)
//   --refresh                re-crawl ids that are already cached
//   --dump-page <file>       save the first book page (and <file>.index.html)
//   --user-agent <ua>        MUST match the browser that produced cf_clearance
//   --headed                 show the browser (needed for the login fallback)
//   --cf-wait ms             time allowed to clear the Cloudflare check (default 120000)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { chromium } from 'patchright';
import { loadCookies, toPlaywrightCookies, fetchPage } from './fetch_wenku8_net_ids.mjs';
import { parseVolumeLabel } from './vol_label.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const SITE = 'https://www.wenku8.net';
const LOGIN_URL = SITE + '/login.php';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : def;
};
const num = (name, def) => {
	const v = Number(opt(name, def));
	return Number.isFinite(v) ? v : def;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const decodeEntities = s => s
	.replace(/&quot;/g, '"')
	.replace(/&#39;/g, "'")
	.replace(/&amp;/g, '&')
	.replace(/&lt;/g, '<')
	.replace(/&gt;/g, '>')
	.replace(/&nbsp;/g, ' ');

const textOf = html => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// The chapter index of a book: /novel/<type>/<id>/index.htm, linked from the
// book page as "小说目录". Returns an absolute url or ''.
export function findIndexUrl(html, id, baseUrl = SITE + '/book/' + id + '.htm') {
	const re = new RegExp('href\\s*=\\s*["\']([^"\']*/novel/[^"\']*/' + id + '/index\\.htm[^"\']*)["\']', 'i');
	const href = (html.match(re) ?? [])[1];
	if (!href) return '';
	try {
		return new URL(href, baseUrl).href;
	} catch {
		return '';
	}
}

// Volume rows of a chapter index page, in page order:
//   <td class="vcss" vid="121395">第一卷 渴望死亡的小丑</td>
// followed by that volume's chapters (<td class="ccss"><a href="121396.htm">).
// The first chapter href gives a deep link for the volume; the row text is the
// label the matcher compares against.
export function parseVolumes(html, baseUrl, seriesTitle = '') {
	const out = [];
	for (const part of html.split(/<td[^>]*class=["'][^"']*\bvcss\b[^"']*["'][^>]*>/i).slice(1)) {
		const end = part.indexOf('</td>');
		const label = textOf(end < 0 ? part : part.slice(0, end));
		if (!label) continue;
		const chapter = (part.match(/href\s*=\s*["']([^"']*?\d+\.htm)["']/i) ?? [])[1] ?? '';
		let url = baseUrl;
		if (chapter) {
			try {
				url = new URL(chapter, baseUrl).href;
			} catch { /* keep the index url */ }
		}
		const { num, unit, subtitle } = parseVolumeLabel(label, seriesTitle);
		out.push({ seq: out.length + 1, label, url, num, unit, subtitle });
	}
	return out;
}

function readIds(fromCsv) {
	if (!fs.existsSync(fromCsv)) return [];
	const ids = new Set();
	for (const line of fs.readFileSync(fromCsv, 'utf8').split(/\r?\n/)) {
		// The CSV is fully quoted ("title","1234",...), so the field separator is
		// "," and an escaped quote inside a title ("a""b") cannot shift the id.
		const cells = line.split('","');
		const raw = cells.length > 1 ? cells[1] : (line.split(',')[1] ?? '');
		const id = String(raw).replace(/^"|"$/g, '').trim();
		if (/^\d+$/.test(id)) ids.add(id);
	}
	return [...ids];
}

async function login(context, username, password, cfWait) {
	const page = await context.newPage();
	await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	const deadline = Date.now() + cfWait;
	while (Date.now() < deadline && /Just a moment|Checking your browser/i.test(await page.title())) {
		console.log('  waiting for the Cloudflare check - solve it in the browser window...');
		await page.waitForTimeout(3000);
	}
	if (/Just a moment|Checking your browser/i.test(await page.title())) {
		throw new Error('Cloudflare not cleared. Use --headed, or export cookies including cf_clearance.');
	}
	const loginForms = page.locator('form').filter({ has: page.locator('input[name="username"]') });
	const plainForm = loginForms.filter({ hasNot: page.locator('input[name="checkcode"]') }).first();
	const form = (await plainForm.count()) ? plainForm : loginForms.first();
	const scope = (await form.count()) ? form : page;
	const user = scope.locator('input[name="username"]').first();
	await user.waitFor({ timeout: 20000 });
	await user.fill(username);
	await scope.locator('input[name="password"]').first().fill(password);
	const captcha = scope.locator('input[name="checkcode"]').first();
	if (await captcha.count()) {
		console.log('  captcha detected - type it into the browser window...');
		const dl = Date.now() + cfWait;
		while (Date.now() < dl && !(await captcha.inputValue().catch(() => ''))) await page.waitForTimeout(1000);
	}
	await scope.locator('input[name="submit"], button[type="submit"], .login-submit').first().click();
	await page.waitForLoadState('domcontentloaded').catch(() => {});
	const body = await page.content();
	if (/用户名不存在|密码错误|验证码错误|登录失败/i.test(body)) throw new Error('login rejected by the site');
	console.log('  login submitted');
	await page.close();
}

async function main() {
	const cookiesInput = opt('--cookies', process.env.WENKU8_COOKIES ?? '');
	const username = opt('--username', process.env.WENKU8_USERNAME ?? '');
	const password = opt('--password', process.env.WENKU8_PASSWORD ?? '');
	const saveState = opt('--save-state', path.join(ROOT, 'playwright', '.auth', 'wenku8.json'));
	const indexFile = path.resolve(ROOT, opt('--index', 'titles/wenku8_net_index.json'));
	const csvFile = path.resolve(ROOT, opt('--from-csv', 'titles/wenku8_ids.csv'));
	const outFile = path.resolve(ROOT, opt('--out', 'titles/wenku8_net_volumes.json'));
	const concurrency = Math.max(1, num('--concurrency', 1));
	const delay = num('--delay', 3000);
	const limit = num('--limit', 0) || 0;
	const dumpPage = opt('--dump-page', '');
	const userAgent = opt('--user-agent', process.env.WENKU8_USER_AGENT ?? DEFAULT_UA);
	const headed = args.includes('--headed');
	const cfWait = num('--cf-wait', 120000);
	const refresh = args.includes('--refresh');

	const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
	let ids = (opt('--ids', '') ? opt('--ids', '').split(',') : readIds(csvFile))
		.map(s => String(s).trim())
		.filter(s => /^\d+$/.test(s));
	if (!ids.length) {
		console.warn('warning: no ids from --ids / --from-csv, crawling the whole index');
		ids = Object.keys(index);
	}
	ids = [...new Set(ids)];
	if (limit) ids = ids.slice(0, limit);

	// --refresh only ignores the cache when deciding what to crawl; it must not
	// throw away ids crawled by an earlier run.
	const cache = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
	const todo = ids.filter(id => refresh || !cache[id]);
	console.log('ids: ' + ids.length + ' (' + todo.length + ' to crawl, ' + (ids.length - todo.length) + ' cached)');
	if (!todo.length) return;

	const cookies = loadCookies(cookiesInput);
	if (!cookies.length && !(username && password)) {
		throw new Error('no auth: pass --cookies (or WENKU8_COOKIES), or --username/--password (or WENKU8_USERNAME/WENKU8_PASSWORD)');
	}
	if (!cookies.some(c => c.name === 'cf_clearance')) {
		console.warn('warning: no cf_clearance cookie. wenku8.net returns a 403 challenge without it.');
	}

	const browser = await chromium.launch({ headless: !headed });
	const context = await browser.newContext({ userAgent, locale: 'zh-CN', ignoreHTTPSErrors: true });
	if (cookies.length) await context.addCookies(toPlaywrightCookies(cookies));
	if (username && password && !cookies.length) {
		await login(context, username, password, cfWait);
		fs.mkdirSync(path.dirname(saveState), { recursive: true });
		fs.writeFileSync(saveState, JSON.stringify(await context.storageState(), null, '\t'));
		console.log('session saved -> ' + path.relative(ROOT, saveState));
	}

	const save = () => {
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, JSON.stringify(cache, null, '\t'));
	};

	const pages = [];
	for (let i = 0; i < concurrency; i++) pages.push(await context.newPage());

	const dump = html => {
		if (!dumpPage || dump.done) return;
		dump.done = true;
		fs.mkdirSync(path.dirname(dumpPage), { recursive: true });
		fs.writeFileSync(dumpPage, html);
		console.log('book page dumped -> ' + dumpPage);
	};
	dump.done = false;
	const dumpIndex = html => {
		if (!dumpPage || dumpIndex.done) return;
		dumpIndex.done = true;
		fs.writeFileSync(dumpPage + '.index.html', html);
		console.log('chapter index dumped -> ' + dumpPage + '.index.html');
	};
	dumpIndex.done = false;

	let empty = 0;
	let failures = 0;
	for (let i = 0; i < todo.length; i += concurrency) {
		const batch = todo.slice(i, i + concurrency);
		const results = await Promise.all(batch.map(async (id, j) => {
			const page = pages[j];
			const seriesTitle = String(index[id]?.title ?? '');
			try {
				const bookUrl = SITE + '/book/' + id + '.htm';
				const bookHtml = await fetchPage(page, bookUrl);
				dump(bookHtml);
				// Follow the "小说目录" link on the book page; when there is none the
				// book page itself may already carry the vcss rows.
				let indexUrl = findIndexUrl(bookHtml, id, bookUrl);
				let indexHtml = bookHtml;
				if (indexUrl && indexUrl !== bookUrl) {
					// The book page and its chapter index are two hits on the same site;
					// space them out like the batch-to-batch delay.
					if (delay) await sleep(delay * (1 + Math.random() * 0.5));
					indexHtml = await fetchPage(page, indexUrl);
					dumpIndex(indexHtml);
				} else {
					indexUrl = bookUrl;
				}
				return { id, seriesTitle, indexUrl, volumes: parseVolumes(indexHtml, indexUrl, seriesTitle) };
			} catch (e) {
				return { id, error: e.message.split('\n')[0] };
			}
		}));
		for (const r of results) {
			if (r.error) {
				failures++;
				console.warn('  id ' + r.id + ': ' + r.error);
				continue;
			}
			if (!r.volumes.length) empty++;
			cache[r.id] = { title: r.seriesTitle, index: r.indexUrl, volumes: r.volumes };
		}
		if (i % (concurrency * 10) === 0) {
			save();
			console.log('  ' + Math.min(i + concurrency, todo.length) + '/' + todo.length + ', ' + Object.keys(cache).length + ' ids cached');
		}
		if (delay) await sleep(delay * (1 + Math.random() * 0.5));
	}
	save();
	await browser.close();
	const withVolumes = Object.values(cache).filter(v => v.volumes?.length).length;
	console.log('volumes: ' + withVolumes + ' series with a volume list, ' + empty + ' empty, ' + failures + ' failed -> ' + path.relative(ROOT, outFile));
	if (empty) {
		console.warn('warning: empty volume lists. Inspect one with --dump-page and check the vcss rows of the chapter index.');
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(e => {
		console.error(e);
		process.exitCode = 1;
	});
}
