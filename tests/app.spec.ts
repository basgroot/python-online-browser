import { test, expect, Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';

/** Build a share URL independently of the app, to prove the format is stable. */
function makeShareUrl(source: string, { embed = false } = {}) {
  const payload = deflateRawSync(Buffer.from(source, 'utf8')).toString('base64url');
  return `${APP}${embed ? '?embed=1' : ''}#c1.${payload}`;
}

/** Tests against the built application served by `vite preview`. */
const APP = 'http://localhost:4173/';

async function open(page: Page, url = APP) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  await page.goto(url);
  // Boot starts eagerly on load; wait for the overlay to clear.
  await expect(page.locator('#run')).toBeEnabled({ timeout: 90_000 });
  return errors;
}

const consoleText = (page: Page) => page.locator('#console').innerText();

const sampleCanvas = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const src = document.getElementById('canvas') as HTMLCanvasElement;
      const off = document.createElement('canvas');
      off.width = src.width;
      off.height = src.height;
      const ctx = off.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y],
  ) as Promise<number[]>;

test('A1: app boots and enables Run', async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator('#boot-overlay')).toBeHidden();
  await expect(page.locator('#status')).toContainText('Ready');
  expect(errors).toEqual([]);
});

test('A2: the default example runs and draws', async ({ page }) => {
  await open(page);
  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.waitForTimeout(1500);

  // Bouncing ball paints a dark blue background.
  const bg = await sampleCanvas(page, 5, 5);
  console.log('  background pixel:', bg);
  expect(bg).toEqual([20, 20, 40]);

  // And the page is still interactive while the game loop runs.
  const responsive = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => 'responsive'),
    new Promise((r) => setTimeout(() => r('frozen'), 2000)),
  ]);
  expect(responsive).toBe('responsive');
});

test('A3: Stop halts the program and re-enables editing', async ({ page }) => {
  await open(page);
  await page.locator('#run').click();
  await page.waitForTimeout(800);
  await page.locator('#stop').click();

  await expect(page.locator('#run')).toBeEnabled();
  await expect(page.locator('#stop')).toBeDisabled();
  expect(await consoleText(page)).toContain('Stopped');
});

test('A4: choosing an example loads its source', async ({ page }) => {
  await open(page);
  await page.locator('#examples').selectOption('mouse_painter');

  // Read the document itself: CodeMirror virtualises long files, so asserting
  // on rendered DOM text would be flaky.
  const source: string = await page.evaluate(() =>
    (window as any).pyplayApp.editor.getValue(),
  );
  expect(source).toContain('Hold the mouse button and drag to paint');
  expect(source).toContain('pygame.mouse.get_pressed');
});

test('A5: share links round-trip through the URL fragment', async ({ page }) => {
  await open(page);

  const marker = 'print("shared-program-marker")';
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(marker);

  await page.locator('#share').click();
  await expect(page.locator('#status')).toContainText('Share link');

  const shared = page.url();
  expect(shared).toContain('#');
  console.log('  share url length:', shared.length);
  // Compression must keep links comfortably short.
  expect(shared.length).toBeLessThan(400);

  // Re-open the link in a clean context and confirm the code came back.
  await page.goto('about:blank');
  await open(page, shared);
  await expect(page.locator('.cm-content')).toContainText('shared-program-marker');
});

test('A6: embed mode hides the editor and runs automatically', async ({ page }) => {
  const program = [
    'import pygame',
    'pygame.init()',
    'screen = pygame.display.set_mode((200, 150))',
    'while True:',
    '    screen.fill((123, 45, 67))',
    '    pygame.display.flip()',
  ].join('\n');

  await page.goto(makeShareUrl(program, { embed: true }));
  await expect(page.locator('#toolbar')).toBeHidden();
  await expect(page.locator('#editor-pane')).toBeHidden();

  // Autoruns without the student pressing anything. Poll rather than sleep:
  // boot is several times slower on Firefox than on Chromium.
  await expect
    .poll(() => sampleCanvas(page, 10, 10), { timeout: 90_000, intervals: [500] })
    .toEqual([123, 45, 67]);
});

test('A7: the draft survives a reload', async ({ page }) => {
  await open(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('print("draft-persistence-check")');
  await page.waitForTimeout(200);

  await page.goto(APP);
  await expect(page.locator('#run')).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('.cm-content')).toContainText('draft-persistence-check');
});

test('A8: errors appear in the console with the right line number', async ({ page }) => {
  await open(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('x = 1\ny = 2\nraise ValueError("from line three")\n');

  await page.locator('#run').click();
  await expect(page.locator('#console .err')).toBeVisible();

  const text = await consoleText(page);
  console.log('  console:\n    ' + text.replace(/\n/g, '\n    '));
  expect(text).toContain('ValueError: from line three');
  expect(text).toContain('line 3');
  expect(text).not.toContain('pyplay');
  await expect(page.locator('#status')).toContainText('error');
});

test('A9: printed output is streamed to the console', async ({ page }) => {
  await open(page);
  await page.locator('#examples').selectOption('hello');
  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });

  const text = await consoleText(page);
  expect(text).toContain('Hello from Python!');
  expect(text).toContain('3 squared is 9');
  expect(text).toContain('Program finished.');
});

test('A10: Ctrl+Enter runs the program', async ({ page }) => {
  await open(page);
  await page.locator('#examples').selectOption('hello');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });
  expect(await consoleText(page)).toContain('Hello from Python!');
});
