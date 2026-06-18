import { appendFile, mkdir } from 'fs/promises';
import { expect, Page, test } from 'patchright/test';
import path from 'path';

const currentDir = import.meta.dirname;

async function saveContent(page: Page, title: string) {
  await page.waitForLoadState('networkidle');
  const content = await page.locator('div.content-area').innerHTML();

  let dir = path.join(currentDir, '../output', title);
  let file = path.join(dir, 'output.html');

  await mkdir(dir, { recursive: true })
  await appendFile(file, content, 'utf-8');
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

async function getTitle(page: Page, index: number) {
  let title = await page.locator('div.book-title').nth(index).getAttribute('title');
  if (title != null) {
    return title
  }
  process.exit(1)
}

test('main', async ({ page }) => {
  await page.goto('https://ritdon.com');

  await waitForLogin(page)

  let title = await getTitle(page, 19)

  await openBook(page, 19)

  await saveContent(page, title)

  while (true) {
    await saveNextPage(page, title)
  }
});
