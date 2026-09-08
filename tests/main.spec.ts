import { test } from 'patchright/test';
import {
  HOME_PAGE,
  loading,
  search,
  switchPage,
  downloadBook,
  getBookNum,
} from './lib/ritdon.js';

const BOOK_INDEX = parseInt(process.env.BOOK_INDEX ?? '0', 10) || 0;
const PAGE = parseInt(process.env.PAGE ?? '0', 10) || 0;
const SEARCH_KEYWORD = process.env.SEARCH_KEYWORD ?? '';
const DOWNLOAD_FULL_PAGE = parseInt(process.env.DOWNLOAD_FULL_PAGE ?? '0', 10) || 0;

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
