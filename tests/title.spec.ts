import { test } from 'patchright/test';
import path from 'path';
import {
  HOME_PAGE,
  projectRoot,
  loading,
  switchPage,
  getBookTitles,
  getMaxPageNum,
  blockImages,
} from './lib/ritdon.js';

const title_file = path.join(projectRoot, 'titles', 'titles.txt');

test('main', async ({ page }) => {
  await page.goto(HOME_PAGE);

  await blockImages(page);

  await loading(page);

  await getBookTitles(page, title_file);

  const max_page = await getMaxPageNum(page);

  for (let i = 1; i < max_page; i++) {
    await switchPage(page, i + 1)
    await loading(page);
    await getBookTitles(page, title_file)
  }

});
