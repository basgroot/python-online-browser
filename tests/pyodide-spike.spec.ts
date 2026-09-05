import { test, expect, Page } from '@playwright/test';

const PAGE = '/spike/pyodide/index.html';
const W = 320, H = 240;

type Boot = {
  skipUnwindSet: boolean;
  hasCanvasApi: boolean;
  loadMs: number;
  packageMs: number;
  totalMs: number;
  pythonVersion: string;
};

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.goto(PAGE);
  const info = (await page.evaluate(() => (window as any).spike.boot())) as Boot;
  return { info, errors };
}

const py = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).spike.run(c), code);

const pyStart = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).spike.start(c), code);

const sample = (page: Page, pts: [number, number][]) =>
  page.evaluate((p) => (window as any).spike.sampleCanvas(p), pts) as Promise<number[][]>;

// Shared preamble: init pygame and grab a display surface.
const INIT = `
import pygame, asyncio, json, time
pygame.init()
screen = pygame.display.set_mode((${W}, ${H}))
`;

test('T0: boots, imports pygame-ce, binds canvas', async ({ page }) => {
  const { info, errors } = await boot(page);
  expect(info.hasCanvasApi, 'pyodide.canvas API present').toBe(true);
  expect(info.skipUnwindSet, '_skip_unwind_fatal_error settable').toBe(true);

  const meta = (await py(page, `
import pygame, json
json.dumps({"pygame": pygame.version.ver, "sdl": ".".join(str(x) for x in pygame.version.SDL)})
`)) as string;

  const ctxs = await page.evaluate(() => (window as any).spike.contextRequests);
  console.log(`  boot=${info.totalMs}ms (runtime ${info.loadMs}ms + pygame ${info.packageMs}ms)`);
  console.log('  ' + meta);
  console.log('  canvas contexts requested:', JSON.stringify(ctxs));
  expect(errors, 'no page errors during boot').toEqual([]);
});

test('T1: shapes render to the real canvas', async ({ page }) => {
  const { errors } = await boot(page);

  // Blue background, red square at (10,10)-(60,60).
  const surf = (await py(page, `${INIT}
screen.fill((0, 0, 255))
pygame.draw.rect(screen, (255, 0, 0), (10, 10, 50, 50))
pygame.display.flip()
await asyncio.sleep(0.05)
json.dumps({"inside": list(screen.get_at((30, 30)))[:3],
            "outside": list(screen.get_at((200, 200)))[:3]})
`)) as string;

  const s = JSON.parse(surf);
  console.log('  pygame surface  inside:', s.inside, ' outside:', s.outside);
  expect(s.inside, 'pygame surface: red square').toEqual([255, 0, 0]);
  expect(s.outside, 'pygame surface: blue bg').toEqual([0, 0, 255]);

  // The decisive check: did it reach the composited DOM canvas?
  const [inside, outside] = await sample(page, [[30, 30], [200, 200]]);
  console.log('  composited canvas inside:', inside, ' outside:', outside);
  expect(inside, 'canvas: red square').toEqual([255, 0, 0]);
  expect(outside, 'canvas: blue bg').toEqual([0, 0, 255]);
  expect(errors).toEqual([]);
});

test('T2: pygame.font and pygame.freetype render text', async ({ page }) => {
  const { errors } = await boot(page);

  const raw = (await py(page, `${INIT}
res = {}

# --- SDL_ttf path (pygame.font) ---
try:
    pygame.font.init()
    res["font_init"] = True
    res["default_font"] = pygame.font.get_default_font()
    f = pygame.font.Font(None, 36)
    surf = f.render("Hello", True, (255, 255, 255))
    res["font_surface_size"] = list(surf.get_size())
    res["font_ink"] = sum(
        1
        for x in range(surf.get_width())
        for y in range(surf.get_height())
        if surf.get_at((x, y))[:3] != (0, 0, 0)
    )
except Exception as e:
    res["font_error"] = f"{type(e).__name__}: {e}"

# --- SysFont ---
try:
    sf = pygame.font.SysFont(None, 24)
    s2 = sf.render("Sys", True, (255, 255, 255))
    res["sysfont_size"] = list(s2.get_size())
except Exception as e:
    res["sysfont_error"] = f"{type(e).__name__}: {e}"

# --- freetype module (separate from pygame.font) ---
try:
    import pygame.freetype
    pygame.freetype.init()
    ft = pygame.freetype.Font(None, 24)
    s3, _ = ft.render("Ft", (255, 255, 255))
    res["freetype_size"] = list(s3.get_size())
except Exception as e:
    res["freetype_error"] = f"{type(e).__name__}: {e}"

# Blit to screen so we can verify on the real canvas.
screen.fill((0, 0, 0))
if "font_error" not in res:
    screen.blit(f.render("Hello", True, (255, 255, 255)), (10, 100))
pygame.display.flip()
await asyncio.sleep(0.05)
json.dumps(res)
`)) as string;

  const r = JSON.parse(raw);
  console.log('  ' + JSON.stringify(r, null, 2).replace(/\n/g, '\n  '));

  expect(r.font_error, 'pygame.font must not error').toBeUndefined();
  expect(r.font_ink, 'rendered glyphs must produce ink').toBeGreaterThan(20);

  // And it must actually reach the canvas.
  const ink = await page.evaluate(
    () => (window as any).spike.countNonBackground(0, 90, 320, 50, [0, 0, 0]),
  );
  console.log('  composited canvas ink pixels in text band:', ink);
  expect(ink, 'text visible on real canvas').toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('T3: keyboard events reach pygame.event.get()', async ({ page }) => {
  const { errors } = await boot(page);

  await pyStart(page, `${INIT}
KEY_LOG = []
RUNNING = True

async def collect():
    global RUNNING
    t0 = time.monotonic()
    while RUNNING and time.monotonic() - t0 < 20:
        for e in pygame.event.get():
            if e.type in (pygame.KEYDOWN, pygame.KEYUP):
                KEY_LOG.append({
                    "type": "KEYDOWN" if e.type == pygame.KEYDOWN else "KEYUP",
                    "key": pygame.key.name(e.key) if e.key else None,
                    "unicode": getattr(e, "unicode", ""),
                })
        screen.fill((20, 20, 20))
        pygame.display.flip()
        await asyncio.sleep(0)

asyncio.ensure_future(collect())
`);

  // Give the collector a moment to start pumping.
  await page.waitForTimeout(400);
  await page.locator('#canvas').click();
  for (const k of ['a', 'ArrowLeft', 'Space']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);

  const log = JSON.parse(
    (await py(page, 'import json; RUNNING = False; json.dumps(KEY_LOG)')) as string,
  );
  console.log('  captured key events:', JSON.stringify(log));

  const downs = log.filter((e: any) => e.type === 'KEYDOWN');
  expect(downs.length, 'KEYDOWN events must be delivered').toBeGreaterThanOrEqual(3);
  expect(downs.map((e: any) => e.key), 'correct key identities').toEqual(
    expect.arrayContaining(['a', 'left', 'space']),
  );
  expect(errors).toEqual([]);
});

test('T4: mouse motion and clicks reach pygame.event.get()', async ({ page }) => {
  const { errors } = await boot(page);

  await pyStart(page, `${INIT}
MOUSE_LOG = []
RUNNING = True

async def collect():
    t0 = time.monotonic()
    while RUNNING and time.monotonic() - t0 < 20:
        for e in pygame.event.get():
            if e.type == pygame.MOUSEBUTTONDOWN:
                MOUSE_LOG.append({"type": "DOWN", "pos": list(e.pos), "button": e.button})
            elif e.type == pygame.MOUSEMOTION:
                MOUSE_LOG.append({"type": "MOTION", "pos": list(e.pos)})
        screen.fill((20, 20, 20))
        pygame.display.flip()
        await asyncio.sleep(0)

asyncio.ensure_future(collect())
`);

  await page.waitForTimeout(400);
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.waitForTimeout(100);
  await page.mouse.move(box.x + 160, box.y + 120);
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + 160, box.y + 120);
  await page.waitForTimeout(400);

  const log = JSON.parse(
    (await py(page, 'import json; RUNNING = False; json.dumps(MOUSE_LOG)')) as string,
  );
  const motions = log.filter((e: any) => e.type === 'MOTION');
  const downs = log.filter((e: any) => e.type === 'DOWN');
  console.log(`  motion events: ${motions.length}, click events: ${downs.length}`);
  console.log('  last motion:', JSON.stringify(motions[motions.length - 1]));
  console.log('  clicks:', JSON.stringify(downs));

  expect(motions.length, 'MOUSEMOTION delivered').toBeGreaterThan(0);
  expect(downs.length, 'MOUSEBUTTONDOWN delivered').toBeGreaterThanOrEqual(1);
  // Coordinates must be canvas-relative and roughly correct.
  expect(downs[0].pos[0]).toBeGreaterThan(140);
  expect(downs[0].pos[0]).toBeLessThan(180);
  expect(downs[0].pos[1]).toBeGreaterThan(100);
  expect(downs[0].pos[1]).toBeLessThan(140);
  expect(errors).toEqual([]);
});

test('T5: sustained frame rate with 100 sprites', async ({ page }) => {
  await boot(page);

  const raw = (await py(page, `${INIT}
import random
sprites = [[random.randint(0, ${W}), random.randint(0, ${H}),
            random.choice([-2, -1, 1, 2]), random.choice([-2, -1, 1, 2])]
           for _ in range(100)]

frames = 0
t0 = time.monotonic()
while time.monotonic() - t0 < 3.0:
    screen.fill((0, 0, 40))
    for s in sprites:
        s[0] = (s[0] + s[2]) % ${W}
        s[1] = (s[1] + s[3]) % ${H}
        pygame.draw.rect(screen, (200, 80, 80), (s[0], s[1], 6, 6))
    pygame.display.flip()
    frames += 1
    await asyncio.sleep(0)

elapsed = time.monotonic() - t0
json.dumps({"frames": frames, "elapsed": round(elapsed, 3), "fps": round(frames / elapsed, 1)})
`)) as string;

  const r = JSON.parse(raw);
  console.log(`  ${r.frames} frames in ${r.elapsed}s = ${r.fps} fps`);
  expect(r.fps, 'must sustain a usable frame rate').toBeGreaterThan(30);
});

test('T6: traceback quality across repeated runs (pyodide#3697)', async ({ page }) => {
  await boot(page);
  await py(page, INIT);

  const CRASH = `
import traceback, json
def inner():
    raise ValueError("boom")
def outer():
    inner()
try:
    outer()
except Exception:
    tb = traceback.format_exc()
json.dumps({"lines": len(tb.strip().split(chr(10))), "text": tb})
`;

  const first = JSON.parse((await py(page, CRASH)) as string);
  const second = JSON.parse((await py(page, CRASH)) as string);
  const third = JSON.parse((await py(page, CRASH)) as string);

  console.log(`  traceback line counts across 3 runs: ${first.lines}, ${second.lines}, ${third.lines}`);
  console.log('  third traceback:\n    ' + third.text.trim().replace(/\n/g, '\n    '));

  expect(third.lines, 'traceback must not grow across runs').toBe(first.lines);
  expect(third.text).toContain('ValueError: boom');
});
