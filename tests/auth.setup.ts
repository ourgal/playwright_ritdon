import { expect, test as setup } from 'patchright/test';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const currentDir = import.meta.dirname;
const authFile = path.join(currentDir, '../playwright/.auth/user.json');

setup('authenticate', async ({ page }) => {
  await page.goto('https://ritdon.com/forum.php');

  await page.fill('#ls_username', process.env.MY_USERNAME!);
  await page.fill('#ls_password', process.env.MY_PASSWORD!);
  await page.click('button.pn.vm');

  await expect(page.getByRole('link', { name: '设置' })).toBeVisible();

  // End of authentication steps.

  await page.context().storageState({ path: authFile });
});
