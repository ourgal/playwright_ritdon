import { appendFile } from 'node:fs/promises';
import { expect, Page, test } from 'patchright/test';
import path from 'path';

const HOME_PAGE = "https://ritdon.com/epub_library.php"
const currentDir = import.meta.dirname;

async function waitForLogin(page: Page) {
  await expect(page.getByRole('button', { name: '搜索' })).toBeVisible();
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

async function getBookTitles(page: Page) {
  for (let i = 0; i < 20; i++) {
    const title = await getBookTitle(page, i)
    const file = path.join(currentDir, '../output', 'titles.txt');
    await appendFile(file, title + '\n', 'utf8');
  }
}

test('main', async ({ page }) => {
  await page.goto(HOME_PAGE);

  // Intercept and block all image requests
  await page.route('**/*', route => {
    if (route.request().resourceType() === 'image') {
      return route.abort();
    }
    return route.continue();
  });

  await waitForLogin(page);

  await getBookTitles(page);

  for (let i = 0; i < 274; i++) {
    await switchPage(page, i + 2)
    await getBookTitles(page)
  }

});
