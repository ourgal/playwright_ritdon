#!/usr/bin/env node
// Crawl book ids from the REAL https://www.wenku8.net catalog.
//
// NOTE: these ids are unrelated to the wowenku.com mirror crawled by
// scripts/fetch_wenku8_ids.mjs -- the two sites use different numbering.
//
// www.wenku8.net sits behind Cloudflare: anonymous requests (curl, fetch and
// even headless Chromium) get a 403 "Just a moment..." challenge. Start from
// cookies exported from a browser that already cleared it (cf_clearance plus
// the login session), or supply a username/password and clear the challenge
// in a headed window.
//
// usage: node scripts/fetch_wenku8_net_ids.mjs [options]
//   --cookies <file|string>  raw "a=b; c=d", Netscape cookies.txt, or storageState JSON
//                            (else WENKU8_COOKIES from .env)
//   --username / --password  headed login fallback (else WENKU8_USERNAME/WENKU8_PASSWORD)
//   --save-state <file>      write session cookies (default playwright/.auth/wenku8.json)
//   --catalog <url>          page template, default .../articlelist.php?page=
//   --start-page N           first page (default 1)
//   --max-pages N            pages this run (default 0 = all)
//   --concurrency N          parallel browser pages (default 1; the site 429s hard)
//   --delay ms               pause between batches (default 2500, +0-50% jitter)
//   --id-pattern <regex>     override book-id link pattern
//   --out <file>             default titles/wenku8_net_index.json
//   --refresh                discard cached index
//   --dump-page <file>       save the first fetched page for debugging
//   --user-agent <ua>        MUST match the browser that produced cf_clearance
//   --headed                 show the browser (needed for the login fallback)
//   --cf-wait ms             time allowed to clear the Cloudflare check (default 120000)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { chromium } from 'patchright';

const ROOT = path.resolve(import.meta.dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const SITE = 'https://www.wenku8.net';
const DEFAULT_CATALOG = `${SITE}/modules/article/articlelist.php?page=`;
const LOGIN_URL = `${SITE}/login.php`;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_ID_PATTERN = '(?:\\/book\\/|\\/books\\/read_|\\/novel\\/|articleinfo\\.php\\?id=|showarticle\\.php\\?id=)(\\d+)';
const DEFAULT_INDEX = path.join(ROOT, 'titles', 'wenku8_net_index.json');
const DEFAULT_STATE = path.join(ROOT, 'playwright', '.auth', 'wenku8.json');

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

const isWenku8Domain = d => /wenku8\.net$/.test(String(d ?? ''));

// Accept: raw "a=b; c=d" string, Netscape cookies.txt, or Playwright storageState JSON.
export function loadCookies(input) {
	if (!input) return [];
	let raw = input;
	if (fs.existsSync(input) && fs.statSync(input).isFile()) raw = fs.readFileSync(input, 'utf8');
	const text = raw.trim();

	if (text.startsWith('{') || text.startsWith('[')) {
		const data = JSON.parse(text);
		const list = Array.isArray(data) ? data : (data.cookies ?? []);
		return list
			.filter(c => c.name && c.value && (!c.domain || isWenku8Domain(c.domain)))
			.map(c => ({
				name: c.name,
				value: c.value,
				domain: c.domain || '.wenku8.net',
				path: c.path || '/',
				expires: c.expires,
				httpOnly: c.httpOnly,
				secure: c.secure,
				sameSite: c.sameSite,
			}));
	}

	// Netscape cookie jar: 7 tab separated fields, optional #HttpOnly_ prefix.
	if (/^#HttpOnly_/m.test(raw) || /^\S+\t\S+\t/m.test(raw)) {
		const out = [];
		for (const line of raw.split(/\r?\n/)) {
			if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
			const httpOnly = line.startsWith('#HttpOnly_');
			const f = line.replace(/^#HttpOnly_/, '').split('\t');
			if (f.length < 7) continue;
			const [domain, , cookiePath, secure, expires, name, value] = f;
			if (!isWenku8Domain(domain)) continue;
			out.push({
				name, value, domain, path: cookiePath || '/',
				secure: secure === 'TRUE', httpOnly,
				expires: Number(expires) || undefined,
			});
		}
		return out;
	}

	// Raw Cookie header value.
	return text.split(';').map(part => {
		const i = part.indexOf('=');
		if (i < 0) return null;
		return {
			name: part.slice(0, i).trim(),
			value: part.slice(i + 1).trim(),
			domain: '.wenku8.net',
			path: '/',
		};
	}).filter(c => c && c.name);
}

export function toPlaywrightCookies(list) {
	return list.map(c => {
		const out = {
			name: c.name,
			value: c.value,
			domain: c.domain || '.wenku8.net',
			path: c.path || '/',
		};
		if (Number.isFinite(c.expires) && c.expires > 0) out.expires = c.expires;
		if (c.httpOnly) out.httpOnly = true;
		if (c.secure) out.secure = true;
		const ss = String(c.sameSite ?? '').toLowerCase();
		if (['strict', 'lax', 'none'].includes(ss)) out.sameSite = ss[0].toUpperCase() + ss.slice(1);
		return out;
	});
}

// Extract ids + titles from the catalog html. The link pattern is overridable
// because the real site's markup differs from the wowenku.com mirror.
// Each entry links to /book/<id>.htm three times: cover (title attr), bold
// title (title attr + text) and a "我要阅读" button. Keep the first real one
// so the button cannot overwrite the title.
const BOILERPLATE = /^(?:我要阅读|加入书架|推荐本书|阅读|下载|立即阅读|详情|詳細)$/;

export function parseCatalog(html, idPattern = DEFAULT_ID_PATTERN, base = SITE) {
	const pageStats = Number((html.match(/<em id="pagestats">\s*\d+\s*\/\s*(\d+)\s*<\/em>/) ?? [])[1]) || 0;
	const pageLinks = [...html.matchAll(/[?&]page=(\d+)/g)].map(m => Number(m[1]));
	const total = pageStats || Math.max(0, ...pageLinks);
	const idRe = new RegExp(idPattern, 'i');
	const books = {};
	const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	let m;
	while ((m = anchorRe.exec(html))) {
		const attrs = m[1];
		const href = (attrs.match(/href\s*=\s*["']([^"']+)["']/i) ?? [])[1];
		if (!href) continue;
		const idm = idRe.exec(href);
		if (!idm) continue;
		const id = idm[1];
		if (books[id]) continue;
		const attrTitle = decodeEntities((attrs.match(/\btitle\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? '').trim();
		const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim().replace(/\s+/g, ' ');
		const title = attrTitle || text;
		if (!title || BOILERPLATE.test(title)) continue;
		const tail = html.slice(m.index, m.index + 1500);
		const authorRaw = (tail.match(/(?:著作作者|作者)\s*[:：]\s*([^<\n]+)/) ?? [])[1] ?? '';
		books[id] = {
			title,
			author: authorRaw.split('/')[0].trim(),
			library: ((tail.match(/\/分类\s*[:：]\s*([^<\s]+)/) ?? [])[1] ?? '').trim(),
			url: new URL(href, base).href,
		};
	}
	return { total, books };
}

export async function fetchPage(page, url) {
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
			const status = resp?.status() ?? 0;
			const html = await page.content();
			// Cloudflare serves 429 "Access denied" when the crawl is too fast;
			// it is a full HTML page, so status/title must be checked explicitly.
			if (status === 429 || status === 403 || /Access denied/i.test(await page.title())) {
				throw new Error(`HTTP ${status} rate-limited`);
			}
			if (/<title>\s*Just a moment|cf-challenge|Checking your browser/i.test(html.slice(0, 5000))) {
				throw new Error('Cloudflare challenge - cookies expired or --user-agent mismatch');
			}
			if (html.length < 3000) throw new Error(`short page (${html.length} bytes)`);
			return html;
		} catch (e) {
			if (attempt === 5) throw e;
			// Back off hard: 5s, 10s, 20s, 40s, 80s plus jitter, so a burst cannot
			// turn into a run of immediate retries against the same rate limiter.
			const wait = 5000 * 2 ** attempt + Math.floor(Math.random() * 2000);
			console.warn(`    retry ${attempt + 1}/5 in ${wait / 1000}s: ${e.message.split('\n')[0]}`);
			await sleep(wait);
		}
	}
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
	// Prefer the login form without a captcha; the site shows two forms.
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

function loadIndex(file) {
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
}

async function main() {
	const cookiesInput = opt('--cookies', process.env.WENKU8_COOKIES ?? '');
	const username = opt('--username', process.env.WENKU8_USERNAME ?? '');
	const password = opt('--password', process.env.WENKU8_PASSWORD ?? '');
	const saveState = opt('--save-state', DEFAULT_STATE);
	const catalog = opt('--catalog', DEFAULT_CATALOG);
	const startPage = num('--start-page', 1);
	const maxPages = num('--max-pages', 0);
	const concurrency = Math.max(1, num('--concurrency', 1));
	const delay = num('--delay', 2500);
	const idPattern = opt('--id-pattern', DEFAULT_ID_PATTERN);
	const outFile = opt('--out', DEFAULT_INDEX);
	const dumpPage = opt('--dump-page', '');
	const userAgent = opt('--user-agent', process.env.WENKU8_USER_AGENT ?? DEFAULT_UA);
	const headed = args.includes('--headed');
	const cfWait = num('--cf-wait', 120000);
	const refresh = args.includes('--refresh');

	const cookies = loadCookies(cookiesInput);
	if (!cookies.length && !(username && password)) {
		throw new Error('no auth: pass --cookies (or WENKU8_COOKIES), or --username/--password (or WENKU8_USERNAME/WENKU8_PASSWORD)');
	}
	if (!cookies.some(c => c.name === 'cf_clearance')) {
		console.warn('warning: no cf_clearance cookie. wenku8.net returns a 403 challenge without it.');
	}
	console.warn('note: cf_clearance is bound to your browser User-Agent; pass --user-agent if it differs from ' + userAgent);

	const browser = await chromium.launch({ headless: !headed });
	const context = await browser.newContext({ userAgent, locale: 'zh-CN', ignoreHTTPSErrors: true });
	if (cookies.length) await context.addCookies(toPlaywrightCookies(cookies));
	if (username && password) {
		await login(context, username, password, cfWait);
		fs.mkdirSync(path.dirname(saveState), { recursive: true });
		fs.writeFileSync(saveState, JSON.stringify(await context.storageState(), null, '\t'));
		console.log(`session saved -> ${path.relative(ROOT, saveState)}`);
	}

	const index = refresh ? {} : loadIndex(outFile);
	let added = 0;
	const merge = books => {
		for (const [id, v] of Object.entries(books)) {
			if (!index[id]) added++;
			index[id] = v;
		}
	};
	const save = () => {
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, JSON.stringify(index, null, '\t'));
	};

	const pages = [];
	for (let i = 0; i < concurrency; i++) pages.push(await context.newPage());
	const probe = await fetchPage(pages[0], `${catalog}${startPage}`);
	if (dumpPage) {
		fs.mkdirSync(path.dirname(dumpPage), { recursive: true });
		fs.writeFileSync(dumpPage, probe);
		console.log(`page ${startPage} dumped -> ${dumpPage}`);
	}
	const catalogBase = new URL(catalog).origin;
	const first = parseCatalog(probe, idPattern, catalogBase);
	const total = first.total || 275;
	const lastPage = maxPages ? Math.min(total, startPage + maxPages - 1) : total;
	if (!first.total) console.warn(`warning: could not detect total pages, assuming ${total}. Use --max-pages to override.`);
	merge(first.books);
	const todo = [];
	for (let p = startPage; p <= lastPage; p++) if (p !== startPage) todo.push(p);
	console.log(`catalog: ${first.total || '?'} pages; fetching ${startPage}..${lastPage} (${todo.length + 1} pages)`);

	let failures = 0;
	for (let i = 0; i < todo.length; i += concurrency) {
		const batch = todo.slice(i, i + concurrency);
		const results = await Promise.all(batch.map(async (p, j) => {
			try {
				return { p, books: parseCatalog(await fetchPage(pages[j], `${catalog}${p}`), idPattern, catalogBase).books };
			} catch (e) {
				return { p, error: e.message };
			}
		}));
		for (const r of results) {
			if (r.error) {
				failures++;
				console.warn(`  page ${r.p}: ${r.error}`);
			} else {
				merge(r.books);
			}
		}
		if (i % (concurrency * 10) === 0) {
			save();
			console.log(`  ${Math.min(i + concurrency, todo.length)}/${todo.length} pages, ${Object.keys(index).length} ids`);
		}
		if (delay) await sleep(delay * (1 + Math.random() * 0.5));
	}
	save();
	await browser.close();
	console.log(`index: ${Object.keys(index).length} ids (+${added}), ${failures} failed pages -> ${path.relative(ROOT, outFile)}`);
	if (failures && !Object.keys(index).length) {
		console.error('no ids collected. Check --dump-page output and adjust --catalog / --id-pattern.');
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(e => {
		console.error(e);
		process.exitCode = 1;
	});
}
