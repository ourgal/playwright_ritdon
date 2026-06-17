import { appendFile } from 'fs/promises';
import { expect, Page, test } from 'patchright/test';

async function saveContent(page: Page) {
  await page.waitForLoadState('networkidle');
  const content = await page.locator('div.content-area').innerHTML();
  await appendFile('output.html', content, 'utf-8');
}

async function saveNextPage(page: Page) {
  const nextBtm = page.getByRole('link', { name: '下一页' });
  await expect(nextBtm).not.toHaveClass("disabled");

  await nextBtm.click();
  await saveContent(page)
}

async function waitForLogin(page: Page) {
  await expect(page.getByRole('button', { name: '搜索' })).toBeVisible();
}

async function openBook(page: Page, index: number) {
  await page.locator('div.book-cover').nth(index).locator('a').click();
}

test('main', async ({ page }) => {
  await page.goto('https://ritdon.com');

  await waitForLogin(page)

  await openBook(page, 19)

  await saveContent(page)

  while (true) {
    await saveNextPage(page)
  }
});
