import { appendFile, mkdir, writeFile, access, constants, rename } from 'fs/promises';
import { expect, Page, test } from 'patchright/test';
import path from 'path';
import dotenv from 'dotenv';

const HOME_PAGE = "https://ritdon.com/epub_library.php"
const currentDir = import.meta.dirname;
dotenv.config();

const BOOK_INDEX = parseInt(process.env.BOOK_INDEX, 10) || 0;
const PAGE = parseInt(process.env.PAGE, 10) || 0;
const SEARCH_KEYWORD = process.env.SEARCH_KEYWORD;
const DOWNLOAD_FULL_PAGE = parseInt(process.env.DOWNLOAD_FULL_PAGE, 10) || 0;

async function saveContent(page: Page, title: string, img_index: number) {
  await verify(page);

  await page.waitForLoadState('networkidle');
  await expect(page.locator('button#btnPanel')).toBeVisible({ timeout: 60000 });
  const body = await page.locator('div.content-area').innerHTML();

  const matches = body.match(/"(data:image\/jpeg;base64,.*?)"/g) || [];

  let tmpBody = body;
  for (const match of matches) {
    const res = await saveBase64(match, title, img_index);
    img_index = res.img_index
    tmpBody = tmpBody.replace(match, res.path)
  }

  const content = tmpBody.replace(/<meta.*?>/g, '').replace(/<style.*?>[\s\S]*?<\/style>/g, '').replace(/<title.*?>.*?<\/title>/g, '').replace(/<div.*?>/g, '').replace(/<\/div>/g, '').replace(/^\s*[\r\n]$/gm, '');

  const dir = path.join(...[currentDir, '../output', title]);
  const file = path.join(dir, 'output.html');

  await mkdir(dir, { recursive: true });
  await appendFile(file, content, 'utf-8');

  const progress = await getSpineIndex(page);
  console.log(`${title} ${progress} ${content.length}`);

  return img_index;
}

async function verify(page: Page, zero: bool = true) {
  await page.waitForLoadState('networkidle');
  const btn = page.getByRole('button', { name: '验证' });
  const count = await btn.count();
  let answer = "";
  if (count > 0) {
    if (zero) {
      answer = "0";
    } else {
      const text = await page.locator("p").innerText();
      console.log(text);
      const regex = /\d+/g;
      const match = text.match(regex);
      if (match) {
        const num1 = parseInt(match[0], 10);
        const num2 = parseInt(match[1], 10);
        answer = (num1 + num2).toString();
      }
    }
    await page.locator("input[name='antispider_captcha']").fill(answer);
    await btn.click();
    return true;
  } else {
    return false;
  }
}

async function nextPage(page: Page) {
  const btn = page.locator('a#btnNext');
  const count = await btn.count();
  if (count > 0) {
    await btn.click();
    return true;
  } else {
    return false;
  }
}

async function saveNextPage(page: Page, title: string, img_index: number) {
  if (await nextPage(page)) {
    return await saveContent(page, title, img_index);
  } else {
    return -1;
  }
}

async function loading(page: Page) {
  await verify(page, false);
  await expect(page.getByRole('button', { name: '跳转' })).toBeVisible({ timeout: 1200000 });
}

async function openBook(page: Page, index: number) {
  await page.locator('div.book-cover').nth(index).locator('a').click();
}

async function getBookTitle(page: Page, index: number): Promise<string> {
  try {
    const title = await page.locator('div.book-title').nth(index).getAttribute('title');
    if (title) {
      console.log(`Found title for book at index ${index}: "${title}"`);
      return title.replace(/[\s\*\?:]/g, '_');
    } else {
      throw new Error(`'title' attribute is null or undefined for book at index ${index}.`);
    }
  } catch (error: any) {
    console.error(`Error getting title for book at index ${index}: ${error.message}`);
    throw error;
  }
}

async function switchPage(page: Page, page_index: number) {
  if (page_index <= 0) {
    return
  }
  await page.locator('#page-input').fill(page_index.toString());
  await page.getByRole('button', { name: '跳转' }).click();
  await page.waitForResponse('**/epub_library.php*');
  await expect(page.locator('div.book-cover').nth(0)).toBeVisible({ timeout: 60000 });
}

async function saveBase64(raw: string, title: string, img_index: number) {
  var base64Data = raw.split(';base64,').pop()

  const dir = path.join(currentDir, '../output', title, 'images');
  await mkdir(dir, { recursive: true });
  const img = path.join(dir, `${img_index}.jpg`);

  writeFile(img, base64Data, 'base64', function (err: any) {
    console.log(err);
  });

  return { path: path.join('images', `${img_index}.jpg`), img_index: img_index + 1 };
}

async function search(page: Page, keyword: string) {
  if (keyword == "") {
    return
  }
  await page.getByPlaceholder("搜索书籍...").fill(keyword)
  await page.getByRole('button', { name: '搜索' }).click();
  await page.waitForResponse('**/epub_library.php*');
}

async function getPageNum(page: Page) {
  const raw = await page.locator('span#bookProgress').innerText();
  console.log(raw)
  const regex = /\d+\/(\d+)/;
  const match = raw.match(regex);
  if (match) {
    const num = match[1];
    return parseInt(num, 10);
  } else {
    throw new Error('Page number not found');
  }
}

async function getSpineIndex(page: Page) {
  const content = await page.content();

  const regex_current = /CURRENT_SPINE = (\d+)/;
  const match_current = content.match(regex_current);

  let current = '';
  if (match_current) {
    current = parseInt(match_current[1], 10) + 1;
  } else {
    throw new Error('Page number not found');
  }

  let total = '';
  const regex_total = /SPINE_TOTAL = (\d+)/;
  const match_total = content.match(regex_total);
  if (match_total) {
    total = parseInt(match_total[1]);
  } else {
    throw new Error('Page number not found');
  }

  return `${current}/${total}`;
}

async function downloadBook(page: Page, index: number) {
  if (index < 0 || index > 19) {
    index = 0;
  }
  let bookTitle: string;
  try {
    bookTitle = await getBookTitle(page, index);
  } catch (error) {
    console.error("Failed to get book title. Aborting test.");
    throw error;
  }

  await openBook(page, index);

  const file = path.join(...[currentDir, '../output', bookTitle, 'output.html']);
  const bakFile = path.join(...[currentDir, '../output', bookTitle, 'output.html.bak']);

  if (await checkFile(file)) {
      await rename(file, bakFile);
  }

  let img_index = 0;
  img_index = await saveContent(page, bookTitle, img_index);

  while (img_index >= 0) {
    img_index = await saveNextPage(page, bookTitle, img_index)
  }
}

async function getBookNum(page: Page) {
  const num = await page.locator('div.book-cover').count();
  console.log(`The number of books is ${num}`);
  return num;
}

async function checkFile(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}


test('main', async ({ page }) => {
  await page.goto(HOME_PAGE);
  await loading(page);
  await search(page, SEARCH_KEYWORD)
  await switchPage(page, PAGE);

  if (DOWNLOAD_FULL_PAGE == 1) {
    const bookNum = await getBookNum(page);
    for (let i = 0; i < bookNum; i++){
      await downloadBook(page, i);

      await page.goto(HOME_PAGE);
      await loading(page);
      await search(page, SEARCH_KEYWORD)
      await switchPage(page, PAGE);
    }
  } else {
    await downloadBook(page, BOOK_INDEX);
  }
});
