import { appendFile, mkdir } from 'fs/promises';
import { expect, Page, test } from 'patchright/test';
import path from 'path';

const BOOK_INDEX_TO_SCRAPE = 19;
const currentDir = import.meta.dirname;

async function saveContent(page: Page, title: string) {
  try {
    await page.waitForLoadState('networkidle');
    const content = await page.locator('div.content-area').innerHTML();

    let dir = path.join(currentDir, '../output', title);
    let file = path.join(dir, 'output.html');

    await mkdir(dir, { recursive: true })
    await appendFile(file, content, 'utf-8');
    console.log(`Saved content to: ${dir}`);
  } catch (error: any) {
    console.error(`Error saving content for "${title}": ${error.message}`);
  }
}

async function saveNextPage(page: Page, title: string) {
  const nextBtm = page.getByRole('link', { name: '下一页' });
  await expect(nextBtm).not.toHaveClass("disabled");

  await nextBtm.click();
  await saveContent(page, title)
}

async function waitForLogin(page: Page) {
  await expect(page.getByRole('button', { name: '搜索' })).toBeVisible();
}

async function openBook(page: Page, index: number) {
  await page.locator('div.book-cover').nth(index).locator('a').click();
}

async function getBookTitle(page: Page, index: number): Promise<string> {
  try {
    const title = await page.locator('div.book-title').nth(index).getAttribute('title');
    if (title) {
      console.log(`Found title for book at index ${index}: "${title}"`);
      return title;
    } else {
      throw new Error(`'title' attribute is null or undefined for book at index ${index}.`);
    }
  } catch (error: any) {
    console.error(`Error getting title for book at index ${index}: ${error.message}`);
    throw error;
  }
}

test('main', async ({ page }) => {
  await page.goto('https://ritdon.com');

  await waitForLogin(page)

  let bookTitle: string;
  try {
    bookTitle = await getBookTitle(page, BOOK_INDEX_TO_SCRAPE);
  } catch (error) {
    console.error("Failed to get book title. Aborting test.");
    throw error;
  }

  await openBook(page, BOOK_INDEX_TO_SCRAPE)

  await saveContent(page, bookTitle)

  while (true) {
    await saveNextPage(page, bookTitle)
  }
});
