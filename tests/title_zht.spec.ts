import { appendFile } from 'node:fs/promises';
import { expect, Page, test } from 'patchright/test';
import path from 'path';

const HOME_PAGE = "https://ritdon.com/epub_library.php"
const currentDir = import.meta.dirname;
const title_file = path.join(currentDir, '../titles', 'titles_zht.txt');

async function loading(page: Page) {
  await expect(page.getByRole('button', { name: '跳转' })).toBeVisible({ timeout: 120000 });
}

async function switchPage(page: Page, page_index: number) {
  await page.locator('#page-input').fill(page_index.toString());
  await page.getByRole('button', { name: '跳转' }).click();
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

async function getBookTitles(page: Page, path: string) {
  const count = await page.locator('div.book-title').count();
  for (let i = 0; i < count; i++) {
    const title = await getBookTitle(page, i)
    await appendFile(path, title + '\n', 'utf8');
  }
}

async function switchCategory(page: Page, cat: string = 'traditional') {
  await page.locator('select#cat-select').selectOption(cat);
  await expect(page.getByRole('button', { name: '跳转' })).toBeVisible({ timeout: 10000 });
}

async function getMaxPageNum(page: Page): Promise<number> {
  const text = await page.locator('div.status-bar').innerText();
  console.log(text)
  const regex = /\d+\/(\d+)/;
  const match = text.match(regex);
  if (match) {
    const num = match[1];
    return parseInt(num, 10);
  } else {
    throw new Error('Max page number not found');
  }
}

async function blcokImages(page: Page) {
  // Intercept and block all image requests
  await page.route('**/*', route => {
    if (route.request().resourceType() === 'image') {
      return route.abort();
    }
    return route.continue();
  });
}


test('main', async ({ page }) => {
  await blcokImages(page);

  await page.goto(HOME_PAGE);

  await loading(page);

  await switchCategory(page);

  await getBookTitles(page, title_file);

  const max_page = await getMaxPageNum(page);

  for (let i = 1; i < max_page; i++) {
    await switchPage(page, i + 1)
    await loading(page);
    await getBookTitles(page, title_file)
  }

});
