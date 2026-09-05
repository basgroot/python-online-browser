import { test, expect, Page } from '@playwright/test';

// These tests characterise the runtime behaviours that dictate how the
// Phase 2 AST transformer must rewrite user code.

const PAGE = '/spike/pyodide/index.html';
const W = 320, H = 240;

async function boot(page: Page) {
  await page.goto(PAGE);
  await page.evaluate(() => (window as any).spike.boot());
}

const py = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).spike.run(c), code);

const pyStart = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).spike.start(c), code);

const INIT = `
import pygame, asyncio, json, time
pygame.init()
screen = pygame.display.set_mode((${W}, ${H}))
`;

test('T7: choosing the right yield primitive', async ({ page }) => {
  await boot(page);

  const raw = (await py(page, `${INIT}
clock = pygame.time.Clock()
results = {}

async def measure(label, delay, use_tick):
    frames = 0
    t0 = time.monotonic()
    while time.monotonic() - t0 < 1.5:
        screen.fill((0, 0, 40))
        pygame.draw.rect(screen, (200, 80, 80), (frames % ${W}, 50, 8, 8))
        pygame.display.flip()
        frames += 1
        if use_tick:
            clock.tick(60)
        await asyncio.sleep(delay)
    el = time.monotonic() - t0
    results[label] = round(frames / el, 1)

await measure("sleep(0)", 0, False)
await measure("sleep(1/60)", 1/60, False)
await measure("tick(60)+sleep(0)", 0, True)
json.dumps(results)
`)) as string;

  const r = JSON.parse(raw);
  console.log('  achieved fps by yield strategy:');
  for (const [k, v] of Object.entries(r)) console.log(`    ${k.padEnd(20)} ${v} fps`);
  expect(Object.keys(r).length).toBe(3);
});

test('T8: pygame.time.set_timer support', async ({ page }) => {
  await boot(page);
  const raw = (await py(page, `${INIT}
res = {}
try:
    ev = pygame.USEREVENT + 1
    pygame.time.set_timer(ev, 100)
    got = 0
    t0 = time.monotonic()
    while time.monotonic() - t0 < 1.2:
        for e in pygame.event.get():
            if e.type == ev:
                got += 1
        await asyncio.sleep(0)
    pygame.time.set_timer(ev, 0)
    res["set_timer"] = "ok"
    res["events_received"] = got
except Exception as e:
    res["set_timer"] = f"{type(e).__name__}: {e}"
json.dumps(res)
`)) as string;
  console.log('  ' + raw);
});

test('T9: time.sleep blocking behaviour', async ({ page }) => {
  await boot(page);
  const raw = (await py(page, `${INIT}
res = {}
t0 = time.monotonic()
time.sleep(0.25)
res["time_sleep_elapsed"] = round(time.monotonic() - t0, 3)
t1 = time.monotonic()
await asyncio.sleep(0.25)
res["asyncio_sleep_elapsed"] = round(time.monotonic() - t1, 3)
json.dumps(res)
`)) as string;
  console.log('  ' + raw);
  const r = JSON.parse(raw);
  // Both should take ~0.25s; the difference is that time.sleep blocks the
  // browser event loop while asyncio.sleep yields it.
  expect(r.asyncio_sleep_elapsed).toBeGreaterThan(0.2);
});

test('T10: a blocking while-loop really does freeze the tab', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);

  // Prove the page is responsive first.
  const before = await page.evaluate(() => 1 + 1);
  expect(before).toBe(2);

  // Fire a genuinely blocking loop (no awaits at all).
  await pyStart(page, `${INIT}
t0 = time.monotonic()
while time.monotonic() - t0 < 4.0:
    screen.fill((80, 0, 0))
    pygame.display.flip()
`);

  // The main thread should now be wedged; a trivial evaluate must not resolve.
  const raced = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => 'responsive'),
    new Promise((r) => setTimeout(() => r('frozen'), 1500)),
  ]);
  console.log(`  during blocking loop, page was: ${raced}`);
  expect(raced, 'blocking loop must freeze the main thread').toBe('frozen');

  // And it must recover once the loop ends.
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => 1 + 1);
  expect(after, 'page recovers after loop exits').toBe(2);
  console.log('  page recovered after loop exited');
});
