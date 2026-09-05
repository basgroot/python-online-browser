import { test, expect, Page } from '@playwright/test';

/**
 * Diagnoses `RuntimeError: can't access resource on platform`, reported when
 * loading a base64-embedded PNG via pygame.image.load(io.BytesIO(...)).
 *
 * Embedding images as base64 is the natural thing to do here: the site has no
 * file uploads yet, so a sprite sheet has to live inside the source.
 */
const PAGE = '/spike/pyodide/index.html';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8AAQv8ZYAwAQ84H+VjtZqAAAAAASUVORK5CYII=';

async function boot(page: Page) {
  await page.goto(PAGE);
  await page.evaluate(() => (window as any).spike.boot());
}

const py = (page: Page, code: string) =>
  page.evaluate((c) => (window as any).spike.run(c), code) as Promise<string>;

test('I1: which image-loading strategies work in Pyodide', async ({ page }) => {
  await boot(page);

  const raw = await py(page, `
import base64, io, json, pygame
pygame.init()
screen = pygame.display.set_mode((64, 64))
DATA = "${PNG}"
res = {}

def attempt(label, fn):
    try:
        surf = fn()
        res[label] = f"ok {surf.get_size()}"
    except Exception as e:
        res[label] = f"{type(e).__name__}: {e}"

attempt("BytesIO", lambda: pygame.image.load(io.BytesIO(base64.b64decode(DATA))))
attempt("BytesIO+namehint",
        lambda: pygame.image.load(io.BytesIO(base64.b64decode(DATA)), "sprite.png"))

def via_file():
    with open("/tmp/sprite.png", "wb") as fh:
        fh.write(base64.b64decode(DATA))
    return pygame.image.load("/tmp/sprite.png")
attempt("tmp file", via_file)

def frombytes():
    surf = pygame.image.load(io.BytesIO(base64.b64decode(DATA)), "s.png")
    return surf
attempt("convert_alpha", lambda: frombytes().convert_alpha())

json.dumps(res, indent=1)
`);

  console.log('  with display initialised:\n    ' + raw.replace(/\\n/g, '\n    '));

  const noDisplay = await py(page, `
import base64, io, json, pygame
res = {}
try:
    surf = pygame.image.load(io.BytesIO(base64.b64decode("${PNG}")), "s.png")
    res["load"] = f"ok {surf.get_size()}"
    try:
        surf.convert_alpha()
        res["convert_alpha"] = "ok"
    except Exception as e:
        res["convert_alpha"] = f"{type(e).__name__}: {e}"
except Exception as e:
    res["load"] = f"{type(e).__name__}: {e}"
json.dumps(res, indent=1)
`);
  console.log('  (second run, display already up):\n    ' + noDisplay.replace(/\\n/g, '\n    '));
});
