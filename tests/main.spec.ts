import { appendFile, mkdir, writeFile } from 'fs/promises';
import { expect, Page, test } from 'patchright/test';
import path from 'path';
import dotenv from 'dotenv';

const HOME_PAGE = "https://ritdon.com/epub_library.php"
const currentDir = import.meta.dirname;
dotenv.config();

const BOOK_INDEX = parseInt(process.env.BOOK_INDEX, 10);
const PAGE = parseInt(process.env.PAGE, 10);
const SEARCH_KEYWORD = process.env.SEARCH_KEYWORD;

async function saveContent(page: Page, title: string, img_index: number) {
  try {
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

    const dir = path.join(currentDir, '../output', title);
    const file = path.join(dir, 'output.html');

    await mkdir(dir, { recursive: true });
    await appendFile(file, content, 'utf-8');
    console.log(`Saved content to: ${dir}`);
  } catch (error: any) {
    console.error(`Error saving content for "${title}": ${error.message}`);
  }

  return img_index;
}

async function saveNextPage(page: Page, title: string, img_index: number) {
  await page.locator('a#btnNext').click();
  return await saveContent(page, title, img_index)
}

async function loading(page: Page) {
  await expect(page.getByRole('button', { name: '跳转' })).toBeVisible({ timeout: 120000 });
}

async function openBook(page: Page, index: number) {
  await page.locator('div.book-cover').nth(index).locator('a').click();
}

async function getBookTitle(page: Page, index: number): Promise<string> {
  try {
    const title = await page.locator('div.book-title').nth(index).getAttribute('title');
    if (title) {
      console.log(`Found title for book at index ${index}: "${title}"`);
      return title.replace(/\s/g, '_');
    } else {
      throw new Error(`'title' attribute is null or undefined for book at index ${index}.`);
    }
  } catch (error: any) {
    console.error(`Error getting title for book at index ${index}: ${error.message}`);
    throw error;
  }
}

async function switchPage(page: Page, page_index: number) {
  await page.locator('#page-input').fill(page_index.toString());
  await page.getByRole('button', { name: '跳转' }).click();
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
  await page.getByPlaceholder("搜索书籍...").fill(keyword)
  await page.getByRole('button', { name: '搜索' }).click();
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


test('main', async ({ page }) => {
  await page.goto(HOME_PAGE);

  await loading(page);

  await search(page, SEARCH_KEYWORD)

  // await switchPage(page, PAGE);

  let bookTitle: string;
  try {
    bookTitle = await getBookTitle(page, BOOK_INDEX);
  } catch (error) {
    console.error("Failed to get book title. Aborting test.");
    throw error;
  }
  let img_index = 0;

  await openBook(page, BOOK_INDEX);

  img_index = await saveContent(page, bookTitle, img_index);

  const pageNum = await getPageNum(page);

  for(let i = 1; i < pageNum; i++) {
    img_index = await saveNextPage(page, bookTitle, img_index)
  }
});
