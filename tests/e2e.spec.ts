import { test, expect, Page } from '@playwright/test';

/**
 * The decisive tests: ordinary blocking pygame code, exactly as a student
 * would copy it from a tutorial, must run in the browser without freezing.
 */

const PAGE = '/spike/e2e/index.html';

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  await page.goto(PAGE);
  const timing = await page.evaluate(() => (window as any).app.boot());
  return { timing, errors };
}

const start = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).app.start(c), code);

const runToCompletion = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).app.runToCompletion(c), code);

const sample = (page: Page, pts: [number, number][]) =>
  page.evaluate((p) => (window as any).app.sample(p), pts) as Promise<number[][]>;

/** Ordinary blocking tutorial code. No async, no awaits, no yields. */
const TUTORIAL_GAME = `
import pygame

pygame.init()
screen = pygame.display.set_mode((320, 240))
clock = pygame.time.Clock()
font = pygame.font.Font(None, 24)

x = 160
running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
    keys = pygame.key.get_pressed()
    if keys[pygame.K_LEFT]:
        x -= 4
    if keys[pygame.K_RIGHT]:
        x += 4
    screen.fill((0, 0, 255))
    pygame.draw.rect(screen, (255, 0, 0), (x, 100, 40, 40))
    screen.blit(font.render("hi", True, (255, 255, 255)), (5, 5))
    pygame.display.flip()
    clock.tick(60)
`;

test('E1: blocking tutorial game runs without freezing the tab', async ({ page }) => {
  const { timing, errors } = await boot(page);
  console.log(`  boot: ${JSON.stringify(timing)}`);

  await start(page, TUTORIAL_GAME);
  await page.waitForTimeout(1200);

  // The whole premise: the page must still be responsive mid-game-loop.
  const responsive = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => 'responsive'),
    new Promise((r) => setTimeout(() => r('frozen'), 2000)),
  ]);
  expect(responsive, 'page must stay responsive during the game loop').toBe('responsive');

  // And it must be drawing.
  const [bg, box] = await sample(page, [[300, 20], [175, 120]]);
  console.log(`  background=${bg} player=${box}`);
  expect(bg, 'blue background drawn').toEqual([0, 0, 255]);
  expect(box, 'red player drawn').toEqual([255, 0, 0]);

  expect(await page.evaluate(() => (window as any).app.isRunning())).toBe(true);
  expect(errors).toEqual([]);
});

test('E2: keyboard input drives the blocking game loop', async ({ page }) => {
  await boot(page);
  await start(page, TUTORIAL_GAME);
  await page.waitForTimeout(800);

  await page.locator('#canvas').click();

  // Observe the rendered player, not interpreter state: user globals are
  // isolated from pyodide.globals by design (see E10).
  const findPlayer = () =>
    page.evaluate(() => (window as any).app.scanRow(120, [255, 0, 0])) as Promise<number>;

  const xBefore = await findPlayer();
  expect(xBefore, 'player must be visible before we start').toBeGreaterThan(0);

  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(200);
  const xRight = await findPlayer();

  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(600);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(200);
  const xLeft = await findPlayer();

  console.log(`  rendered player x: ${xBefore} -> right ${xRight} -> left ${xLeft}`);
  expect(xRight, 'holding ArrowRight must move the player right').toBeGreaterThan(xBefore);
  expect(xLeft, 'holding ArrowLeft must move it back').toBeLessThan(xRight);
});

test('E3: stop() halts a running infinite loop', async ({ page }) => {
  await boot(page);
  await start(page, TUTORIAL_GAME);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).app.isRunning())).toBe(true);

  await page.evaluate(() => (window as any).app.stop());
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => (window as any).app.isRunning())).toBe(false);
  const result = await page.evaluate(() => (window as any).app.result);
  console.log('  result after stop:', JSON.stringify(result));
  expect(result.status).toBe('stopped');
});

test('E4: frame pacing lands near 60fps', async ({ page }) => {
  await boot(page);
  await start(page, TUTORIAL_GAME);
  await page.waitForTimeout(500);

  const before = await page.evaluate(() =>
    (window as any).app.runtime.pyodide.runPython('import pyplay.runtime as r; r.state["frames"]'),
  );
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() =>
    (window as any).app.runtime.pyodide.runPython('import pyplay.runtime as r; r.state["frames"]'),
  );

  const fps = (after - before) / 2;
  console.log(`  measured ${fps.toFixed(1)} fps over 2s`);
  expect(fps, 'should pace near 60fps, not spin at thousands').toBeGreaterThan(40);
  expect(fps, 'must not exceed the requested framerate').toBeLessThan(75);
});

test('E5: a render loop with no clock.tick is auto-paced', async ({ page }) => {
  await boot(page);
  // No clock.tick at all - naive code that would otherwise spin at ~7500fps.
  await start(page, `
import pygame
pygame.init()
screen = pygame.display.set_mode((320, 240))
while True:
    screen.fill((10, 40, 10))
    pygame.display.flip()
`);
  await page.waitForTimeout(500);

  const before = await page.evaluate(() =>
    (window as any).app.runtime.pyodide.runPython('import pyplay.runtime as r; r.state["frames"]'),
  );
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() =>
    (window as any).app.runtime.pyodide.runPython('import pyplay.runtime as r; r.state["frames"]'),
  );

  const fps = (after - before) / 2;
  console.log(`  un-throttled loop auto-paced to ${fps.toFixed(1)} fps`);
  expect(fps, 'auto-pacing must cap the loop').toBeLessThan(75);
  expect(fps, 'but still animate smoothly').toBeGreaterThan(40);
});

test('E6: runtime errors report the student\'s own line number', async ({ page }) => {
  await boot(page);
  const result: any = await runToCompletion(page, `
import pygame
pygame.init()
screen = pygame.display.set_mode((320, 240))
count = 0
while True:
    count += 1
    if count > 3:
        raise ValueError("deliberate")
    pygame.display.flip()
`);
  console.log('  error report:\n    ' + String(result.error).replace(/\n/g, '\n    '));
  expect(result.status).toBe('error');
  expect(result.error).toContain('ValueError: deliberate');
  expect(result.error).toContain('line 9');
  // Internal frames must not leak into the student's traceback.
  expect(result.error).not.toContain('pyplay');
  expect(result.error).not.toContain('_pw_yield');
});

test('E7: syntax errors are reported cleanly', async ({ page }) => {
  await boot(page);
  const result: any = await runToCompletion(page, 'while True\n    print(1)\n');
  console.log('  syntax error:', JSON.stringify(result.error));
  expect(result.status).toBe('error');
  expect(result.error).toContain('SyntaxError');
});

test('E8: pygame.time.set_timer shim delivers events', async ({ page }) => {
  await boot(page);
  const result: any = await runToCompletion(page, `
import pygame
pygame.init()
screen = pygame.display.set_mode((320, 240))
TICK = pygame.USEREVENT + 1
pygame.time.set_timer(TICK, 100)
got = 0
frames = 0
while got < 3 and frames < 600:
    frames += 1
    for e in pygame.event.get():
        if e.type == TICK:
            got += 1
    screen.fill((0, 0, 0))
    pygame.display.flip()
print("timer events:", got)
`);
  console.log('  ' + JSON.stringify(result));
  expect(result.status, result.error ?? '').toBe('finished');
  const stdout = await page.evaluate(() => (window as any).app.stdout.join('\n'));
  expect(stdout).toContain('timer events: 3');
});

test('E9: pygame.freetype fails with a helpful message', async ({ page }) => {
  await boot(page);
  const result: any = await runToCompletion(page, `
import pygame, pygame.freetype
pygame.init()
f = pygame.freetype.Font(None, 24)
`);
  console.log('  ' + JSON.stringify(result.error));
  expect(result.status).toBe('error');
  expect(result.error).toContain('pygame.font');
});

test('E10: consecutive runs stay isolated', async ({ page }) => {
  await boot(page);
  const first: any = await runToCompletion(page, 'leaked = 123\nprint("first done")\n');
  expect(first.status).toBe('finished');

  const second: any = await runToCompletion(page, `
try:
    print("leaked is", leaked)
except NameError:
    print("clean slate")
`);
  expect(second.status).toBe('finished');
  const stdout = await page.evaluate(() => (window as any).app.stdout.join('\n'));
  console.log('  stdout:', JSON.stringify(stdout));
  expect(stdout).toContain('clean slate');
});
