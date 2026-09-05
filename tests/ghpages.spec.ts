import { test, expect, Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';

/**
 * GitHub Pages project-site compatibility.
 *
 * The server backing these tests is deliberately harsher than Pages itself:
 * it serves .wasm as application/octet-stream, so a pass here also proves
 * Pyodide's instantiateStreaming -> ArrayBuffer fallback holds.
 */
const SITE = 'http://localhost:4174/python-web/';

async function open(page: Page, url = SITE) {
  const errors: string[] = [];
  const notes: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push('console.error: ' + t);
    if (/wasm instantiation failed|MIME/i.test(t)) notes.push(t);
  });
  await page.goto(url);
  await expect(page.locator('#run')).toBeEnabled({ timeout: 120_000 });
  return { errors, notes };
}

test('G1: boots from a subpath with no custom headers', async ({ page }) => {
  const { errors, notes } = await open(page);

  await expect(page.locator('#boot-overlay')).toBeHidden();
  await expect(page.locator('#status')).toContainText('Ready');

  // The server mislabels .wasm on purpose. Booting anyway proves the MIME fix
  // works, so the site does not depend on host header configuration.
  console.log('  wasm MIME complaints:', JSON.stringify(notes));
  expect(notes, 'the MIME fix must prevent any instantiation failure').toEqual([]);

  expect(errors).toEqual([]);
});

test('G2: every asset resolves under the subpath (no 404s)', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });

  await open(page);
  await page.locator('#run').click();
  await page.waitForTimeout(2500);

  console.log('  failed requests:', JSON.stringify(failures));
  expect(failures, 'nothing may 404 under the project subpath').toEqual([]);
});

test('G3: pygame actually runs and draws on Pages', async ({ page }) => {
  await open(page);
  await page.locator('#run').click();
  await page.waitForTimeout(2000);

  const bg = await page.evaluate(() => {
    const src = document.getElementById('canvas') as HTMLCanvasElement;
    const off = document.createElement('canvas');
    off.width = src.width;
    off.height = src.height;
    const ctx = off.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(5, 5, 1, 1).data;
    return [d[0], d[1], d[2]];
  });

  console.log('  canvas background:', bg);
  expect(bg).toEqual([20, 20, 40]);
});

test('G4: share links work under the subpath', async ({ page }) => {
  const program = [
    'import pygame',
    'pygame.init()',
    'screen = pygame.display.set_mode((200, 150))',
    'while True:',
    '    screen.fill((9, 121, 205))',
    '    pygame.display.flip()',
  ].join('\n');

  const payload = deflateRawSync(Buffer.from(program, 'utf8')).toString('base64url');
  await page.goto(`${SITE}?embed=1#c1.${payload}`);

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const src = document.getElementById('canvas') as HTMLCanvasElement;
          const off = document.createElement('canvas');
          off.width = src.width;
          off.height = src.height;
          const ctx = off.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(src, 0, 0);
          const d = ctx.getImageData(10, 10, 1, 1).data;
          return [d[0], d[1], d[2]];
        }),
      { timeout: 120_000, intervals: [500] },
    )
    .toEqual([9, 121, 205]);
});
