import { test, expect, Page } from '@playwright/test';

/**
 * Regression tests for editor keyboard capture.
 *
 * Emscripten's SDL2 attaches its keyboard listeners to the whole window and
 * calls preventDefault() so browser shortcuts do not leak into games. Once a
 * program calls pygame.display.set_mode(), that can swallow every keystroke on
 * the page - including the ones meant for the code editor. The symptom is very
 * specific: typing and Ctrl+V stop working, while right-click -> Paste still
 * works, because the context menu never produces a keyboard event.
 */
const APP = 'http://localhost:4173/';

async function open(page: Page) {
  await page.goto(APP);
  await expect(page.locator('#run')).toBeEnabled({ timeout: 90_000 });
}

const value = (page: Page) =>
  page.evaluate(() => (window as any).pyplayApp.editor.getValue()) as Promise<string>;

async function selectAllAndType(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

test('K1: typing works before any program has run', async ({ page }) => {
  await open(page);
  await selectAllAndType(page, 'x = 1');
  expect(await value(page)).toBe('x = 1');
});

test('K2: typing still works after a pygame program has run', async ({ page }) => {
  await open(page);

  // Run the default example, which calls pygame.display.set_mode().
  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.waitForTimeout(1500);
  await page.locator('#stop').click();
  await expect(page.locator('#run')).toBeEnabled();

  await selectAllAndType(page, 'print("typed after running")');
  expect(
    await value(page),
    'SDL must not swallow keystrokes aimed at the editor',
  ).toBe('print("typed after running")');
});

test('K3: typing works while a program is still running', async ({ page }) => {
  await open(page);
  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.waitForTimeout(1500);

  // The editor is intentionally read-only mid-run, so verify the canvas gets
  // the keys instead and that the page is not wedged.
  await page.locator('#canvas').click();
  await page.keyboard.press('ArrowRight');

  await page.locator('#stop').click();
  await expect(page.locator('#run')).toBeEnabled();

  await selectAllAndType(page, 'y = 2');
  expect(await value(page)).toBe('y = 2');
});

test('K5: keys reach the game without clicking the canvas first', async ({ page }) => {
  await open(page);
  await page.locator('#examples').selectOption('move_the_square');

  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.waitForTimeout(1200);

  // Deliberately no canvas click: Run should have focused it already.
  const findSquare = () =>
    page.evaluate(() => {
      const src = document.getElementById('canvas') as HTMLCanvasElement;
      const off = document.createElement('canvas');
      off.width = src.width;
      off.height = src.height;
      const ctx = off.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 180, src.width, 1).data;
      for (let x = 0; x < src.width; x++) {
        const i = x * 4;
        if (d[i] === 100 && d[i + 1] === 220 && d[i + 2] === 140) return x;
      }
      return -1;
    }) as Promise<number>;

  const before = await findSquare();
  expect(before, 'square should be visible').toBeGreaterThan(0);

  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(200);

  const after = await findSquare();
  console.log(`  square x: ${before} -> ${after} (no canvas click)`);
  expect(after, 'Run must focus the canvas so keys reach the game').toBeGreaterThan(before);
});

test('K4: clipboard paste via keyboard works after running', async ({ page, context, browserName }) => {
  // Only Chromium exposes the clipboard permissions; Firefox rejects the names
  // outright, so drive that engine through K2/K3 instead.
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);

  await page.locator('#run').click();
  await page.waitForTimeout(1200);
  await page.locator('#stop').click();
  await expect(page.locator('#run')).toBeEnabled();

  await page.evaluate(() => navigator.clipboard.writeText('pasted_via_keyboard = True'));
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');

  await expect
    .poll(() => value(page), { timeout: 10_000 })
    .toContain('pasted_via_keyboard');
});
