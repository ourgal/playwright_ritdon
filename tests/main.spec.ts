import { appendFile } from 'fs/promises';
import { expect, Page, test } from 'patchright/test';

async function saveContent(page: Page) {
  await page.waitForLoadState('networkidle');
  const content = await page.locator('div.content-area').innerHTML();
  await appendFile('output.html', content, 'utf-8');
}

test('main', async ({ page }) => {
  await page.goto('https://ritdon.com');

  await expect(page.getByRole('button', { name: '搜索' })).toBeVisible();

  await page.locator('div.book-cover').nth(0).locator('a').click();

  saveContent(page)

  await page.getByRole('link', { name: '下一页' }).click();
  saveContent(page)

  await page.getByRole('link', { name: '下一页' }).click();
  saveContent(page)

  await page.getByRole('link', { name: '下一页' }).click();
  saveContent(page)

  await page.getByRole('link', { name: '下一页' }).click();
  saveContent(page)
});
