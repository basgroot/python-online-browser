import { test, expect, Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';

/** Multi-file projects in the real, built app. */
const APP = 'http://localhost:4173/';

async function open(page: Page, url = APP) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  await page.goto(url);
  await expect(page.locator('#run')).toBeEnabled({ timeout: 90_000 });
  return errors;
}

const consoleText = (page: Page) => page.locator('#console').innerText();
const files = (page: Page) =>
  page.evaluate(() => (window as any).pyplayApp.getFiles()) as Promise<Record<string, string>>;

async function setFile(page: Page, name: string, source: string) {
  await page.evaluate(
    ([n, s]) => {
      const app = (window as any).pyplayApp;
      if (!(n in app.getFiles())) app.addFile(n, '');
      app.editor.switchTo(n);
      app.editor.setValue(s);
    },
    [name, source],
  );
}

function projectUrl(project: Record<string, string>, { embed = false } = {}) {
  const json = JSON.stringify({ v: 1, files: project });
  const payload = deflateRawSync(Buffer.from(json, 'utf8')).toString('base64url');
  return `${APP}${embed ? '?embed=1' : ''}#c2.${payload}`;
}

test('M1: the shipped two-file example loads with both tabs', async ({ page }) => {
  await open(page);
  await page.locator('#examples').selectOption('space_game');

  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab[data-file="main.py"]')).toBeVisible();
  await expect(page.locator('.tab[data-file="sprites.py"]')).toBeVisible();

  const loaded = await files(page);
  expect(Object.keys(loaded).sort()).toEqual(['main.py', 'sprites.py']);
});

test('M2: the two-file example runs and draws', async ({ page }) => {
  const errors = await open(page);
  await page.locator('#examples').selectOption('space_game');
  await page.locator('#run').click();
  await expect(page.locator('#stop')).toBeEnabled();
  await page.waitForTimeout(2000);

  const bg = await page.evaluate(() => {
    const src = document.getElementById('canvas') as HTMLCanvasElement;
    const off = document.createElement('canvas');
    off.width = src.width;
    off.height = src.height;
    const ctx = off.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(2, 200, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  console.log('  background:', bg);
  expect(bg).toEqual([10, 10, 30]);
  expect(errors).toEqual([]);
});

test('M3: main.py can import a file the student just created', async ({ page }) => {
  await open(page);

  await setFile(page, 'greeter.py', 'def hello(name):\n    return "hi " + name\n');
  await setFile(page, 'main.py', 'import greeter\nprint(greeter.hello("world"))\n');

  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });
  expect(await consoleText(page)).toContain('hi world');
});

test('M4: a loop inside a helper does not freeze the tab', async ({ page }) => {
  await open(page);

  // helper.spin() contains a while-loop, so it becomes async and main.py must
  // await it across the file boundary.
  await setFile(page, 'helper.py', [
    'def spin(n):',
    '    total = 0',
    '    while total < n:',
    '        total += 1',
    '    return total',
  ].join('\n'));
  await setFile(page, 'main.py', 'import helper\nprint("total", helper.spin(50000))\n');

  await page.locator('#run').click();

  const responsive = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => 'responsive'),
    new Promise((r) => setTimeout(() => r('frozen'), 2500)),
  ]);
  expect(responsive, 'cross-file loop must still yield to the browser').toBe('responsive');

  await expect(page.locator('#status')).toContainText('Finished', { timeout: 60_000 });
  expect(await consoleText(page)).toContain('total 50000');
});

test('M5: errors in a helper name the helper file', async ({ page }) => {
  await open(page);
  await setFile(page, 'broken.py', 'def boom():\n    raise ValueError("from the helper")\n');
  await setFile(page, 'main.py', 'import broken\nbroken.boom()\n');

  await page.locator('#run').click();
  await expect(page.locator('#console .err')).toBeVisible();

  const text = await consoleText(page);
  console.log('  traceback:\n    ' + text.replace(/\n/g, '\n    '));
  expect(text).toContain('ValueError: from the helper');
  expect(text).toContain('broken.py');
  expect(text).toContain('main.py');
  expect(text).not.toContain('pyplay');
});

test('M6: editing a helper takes effect on the next run', async ({ page }) => {
  await open(page);
  await setFile(page, 'conf.py', 'NAME = "before"\n');
  await setFile(page, 'main.py', 'import conf\nprint("name is", conf.NAME)\n');

  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });
  expect(await consoleText(page)).toContain('name is before');

  await setFile(page, 'conf.py', 'NAME = "after"\n');
  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });
  expect(await consoleText(page), 'modules must not be cached between runs').toContain(
    'name is after',
  );
});

test('M7: tabs switch files and preserve their contents', async ({ page }) => {
  await open(page);
  await setFile(page, 'a.py', 'A = 1\n');
  await setFile(page, 'main.py', 'import a\n');

  await page.locator('.tab[data-file="a.py"]').click();
  await expect(page.locator('.tab[data-file="a.py"]')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => (window as any).pyplayApp.editor.getValue())).toContain('A = 1');

  await page.locator('.tab[data-file="main.py"]').click();
  expect(await page.evaluate(() => (window as any).pyplayApp.editor.getValue())).toContain(
    'import a',
  );
});

test('M8: main.py cannot be deleted and bad names are rejected', async ({ page }) => {
  await open(page);

  // main.py has no close button.
  await expect(page.locator('.tab[data-file="main.py"] .close')).toHaveCount(0);

  const checks = await page.evaluate(() => {
    const app = (window as any).pyplayApp;
    return {
      space: app.validateFileName('my game.py'),
      noExt: app.validateFileName('helper'),
      digit: app.validateFileName('2048.py'),
      reserved: app.validateFileName('pygame.py'),
      good: app.validateFileName('helper.py'),
    };
  });
  console.log('  validation:', JSON.stringify(checks, null, 2));
  expect(checks.space).toBeTruthy();
  expect(checks.noExt).toBeTruthy();
  expect(checks.digit).toBeTruthy();
  expect(checks.reserved).toBeTruthy();
  expect(checks.good).toBeNull();
});

test('M9: share links carry every file', async ({ page }) => {
  const project = {
    'main.py': 'import lib\nprint(lib.answer())\n',
    'lib.py': 'def answer():\n    return 42\n',
  };

  await open(page, projectUrl(project));

  const loaded = await files(page);
  expect(Object.keys(loaded).sort()).toEqual(['lib.py', 'main.py']);
  await expect(page.locator('.tab')).toHaveCount(2);

  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });
  expect(await consoleText(page)).toContain('42');
});

test('M10: the app produces multi-file share links itself', async ({ page }) => {
  await open(page);
  await setFile(page, 'lib.py', 'VALUE = 7\n');
  await setFile(page, 'main.py', 'import lib\nprint("value", lib.VALUE)\n');

  // The click handler is async, so wait for it to finish before reading the URL.
  await page.locator('#share').click();
  await expect(page.locator('#status')).toContainText('Share link');
  const url = page.url();
  expect(url).toContain('#c2.');

  await page.goto('about:blank');
  await open(page, url);
  const loaded = await files(page);
  expect(Object.keys(loaded).sort()).toEqual(['lib.py', 'main.py']);

  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });
  expect(await consoleText(page)).toContain('value 7');
});

test('M11: a whole project survives a reload', async ({ page }) => {
  await open(page);
  await setFile(page, 'notes.py', 'NOTE = "persisted"\n');
  await setFile(page, 'main.py', 'import notes\nprint(notes.NOTE)\n');
  await page.waitForTimeout(300);

  await page.goto(APP);
  await expect(page.locator('#run')).toBeEnabled({ timeout: 90_000 });

  const loaded = await files(page);
  expect(Object.keys(loaded).sort()).toEqual(['main.py', 'notes.py']);
  expect(loaded['notes.py']).toContain('persisted');
});

test('M13: base64 sprites in a helper load and convert (the chess case)', async ({ page }) => {
  await open(page);

  // A 2x2 PNG, embedded the way you would embed a sprite sheet with no uploads.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8AAQv8ZYAwAQ84H+VjtZqAAAAAASUVORK5CYII=';

  await setFile(page, 'chesspieces.py', [
    'import base64, io, pygame',
    '',
    `WHITE_PAWN = '''${PNG}'''`,
    '',
    'def load(data, size):',
    '    img = pygame.image.load(io.BytesIO(base64.b64decode(data))).convert_alpha()',
    '    return pygame.transform.smoothscale(img, (size, size))',
    '',
    'S = 40',
    'pieces = {1: load(WHITE_PAWN, S)}',
  ].join('\n'));

  // The display is created *before* the import, exactly as in real pygame code.
  await setFile(page, 'main.py', [
    'import pygame',
    'pygame.init()',
    'screen = pygame.display.set_mode((160, 160))',
    'import chesspieces',
    'screen.fill((0, 0, 0))',
    'screen.blit(chesspieces.pieces[1], (0, 0))',
    'pygame.display.flip()',
    'print("piece size", chesspieces.pieces[1].get_size())',
  ].join('\n'));

  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Finished', { timeout: 30_000 });

  const text = await consoleText(page);
  console.log('  ' + text.trim().replace(/\n/g, '\n  '));
  expect(text).toContain('piece size (40, 40)');
  expect(text).not.toContain("can't access resource");
});

test('M12: a circular import is reported clearly, not as a crash', async ({ page }) => {
  await open(page);
  await setFile(page, 'a.py', 'import main\nX = 1\n');
  await setFile(page, 'main.py', 'import a\nprint(a.X)\n');

  await page.locator('#run').click();
  await expect(page.locator('#console .err')).toBeVisible();
  const text = await consoleText(page);
  console.log('  ' + text.trim());
  expect(text).toContain('circular import');
});
