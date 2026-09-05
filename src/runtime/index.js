/**
 * Browser-side runtime: boots Pyodide, binds the SDL canvas, and runs
 * student Python through the pyplay transformer.
 *
 * Constraints established by the Phase 0 spike (see tests/pyodide-spike.spec.ts):
 *
 *  - pygame renders through Emscripten's SDL2 port, which requires a canvas
 *    whose id is literally "canvas".
 *  - `pyodide._api._skip_unwind_fatal_error` must be set or SDL init reports
 *    "Pyodide has suffered a fatal error". It is never pre-initialised, so it
 *    cannot be feature-detected; just set it.
 *  - pygame is main-thread only. Pyodide hard-codes
 *    `_emscripten_supports_offscreencanvas = () => 0`, so there is no worker
 *    escape hatch, and a blocking loop therefore freezes the whole tab.
 */

export const PYODIDE_VERSION = '314.0.6';
export const REQUIRED_CANVAS_ID = 'canvas';

const PYPLAY_FILES = ['__init__.py', 'runtime.py', 'transform.py', 'session.py'];
const PYPLAY_DIR = '/home/pyodide/pyplay';

export class PythonRuntime {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas   must have id="canvas"
   * @param {string} [opts.indexURL]          where the pinned Pyodide lives
   * @param {string} [opts.pyplayURL]         where the pyplay .py sources live
   * @param {Record<string,string>} [opts.pyplaySources]
   *        pyplay sources inlined at build time; avoids a runtime fetch and
   *        keeps the app working offline. Takes precedence over pyplayURL.
   * @param {(s: string) => void} [opts.onStdout]
   * @param {(s: string) => void} [opts.onStderr]
   * @param {(stage: string, detail?: object) => void} [opts.onStatus]
   */
  constructor(opts = {}) {
    if (!opts.canvas) throw new Error('PythonRuntime requires a canvas');
    if (opts.canvas.id !== REQUIRED_CANVAS_ID) {
      throw new Error(
        `SDL requires the canvas id to be "${REQUIRED_CANVAS_ID}", got "${opts.canvas.id}"`,
      );
    }

    this.canvas = opts.canvas;
    this.indexURL = opts.indexURL ?? '/vendor/pyodide/';
    this.pyplayURL = opts.pyplayURL ?? '/python/pyplay';
    this.pyplaySources = opts.pyplaySources ?? null;
    this.fixWasmMime = opts.fixWasmMime ?? true;
    this.onStdout = opts.onStdout ?? (() => {});
    this.onStderr = opts.onStderr ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});

    this.pyodide = null;
    this.session = null;
    this.booted = false;
    this._bootPromise = null;
  }

  /** Idempotent; concurrent callers share one boot. */
  boot() {
    if (!this._bootPromise) this._bootPromise = this._boot();
    return this._bootPromise;
  }

  async _boot() {
    const t0 = performance.now();
    if (this.fixWasmMime) installWasmMimeFix();
    this.onStatus('loading-runtime');

    // Deliberately dynamic: Pyodide is a vendored runtime asset loaded from a
    // path that depends on the deployment base, not a bundled module. Vite
    // must leave it alone rather than try to trace it at build time.
    const { loadPyodide } = await import(/* @vite-ignore */ `${this.indexURL}pyodide.mjs`);
    this.pyodide = await loadPyodide({
      indexURL: this.indexURL,
      stdout: (s) => this.onStdout(s),
      stderr: (s) => this.onStderr(s),
    });
    const tRuntime = performance.now();

    // Must precede any SDL initialisation.
    if (this.pyodide._api) this.pyodide._api._skip_unwind_fatal_error = true;

    this.onStatus('binding-canvas');
    if (this.pyodide.canvas?.setCanvas2D) {
      this.pyodide.canvas.setCanvas2D(this.canvas);
    } else if (this.pyodide._module) {
      this.pyodide._module.canvas = this.canvas;
    }

    this.onStatus('loading-pygame');
    await this.pyodide.loadPackage('pygame-ce');
    const tPygame = performance.now();

    this.onStatus('installing-pyplay');
    await this._installPyplay();
    this.session = this.pyodide.pyimport('pyplay.session');

    this.booted = true;
    const timing = {
      runtimeMs: Math.round(tRuntime - t0),
      pygameMs: Math.round(tPygame - tRuntime),
      totalMs: Math.round(performance.now() - t0),
    };
    this.onStatus('ready', timing);
    return timing;
  }

  async _installPyplay() {
    const sources = this.pyplaySources
      ? PYPLAY_FILES.map((name) => {
          const text = this.pyplaySources[name];
          if (typeof text !== 'string') throw new Error(`missing inlined pyplay/${name}`);
          return [name, text];
        })
      : await Promise.all(
          PYPLAY_FILES.map(async (name) => {
            const res = await fetch(`${this.pyplayURL}/${name}`);
            if (!res.ok) throw new Error(`cannot fetch pyplay/${name}: ${res.status}`);
            return [name, await res.text()];
          }),
        );

    this.pyodide.FS.mkdirTree(PYPLAY_DIR);
    for (const [name, text] of sources) {
      this.pyodide.FS.writeFile(`${PYPLAY_DIR}/${name}`, text);
    }

    this.pyodide.runPython(`
import os, sys

if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')

# Confine SDL's keyboard listeners to the canvas.
#
# By default Emscripten's SDL2 listens on the whole window and calls
# preventDefault(), so once a program calls display.set_mode() every keystroke
# on the page is swallowed - including those meant for the code editor. SDL
# reads this hint from the environment when the video subsystem starts, so it
# must be set before the student's pygame.init() runs.
os.environ['SDL_EMSCRIPTEN_KEYBOARD_ELEMENT'] = '#canvas'
`);
  }

  /** Transform-only pre-flight, for editor warnings before running. */
  prepare(source) {
    this._assertBooted();
    return toJs(this.session.prepare(source));
  }

  /** Pre-flight a whole project without running it. */
  prepareProject(files, entry = 'main.py') {
    this._assertBooted();
    return this._withPyFiles(files, (py) => toJs(this.session.prepare_project(py, entry)));
  }

  /**
   * Transform and execute a multi-file project starting at `entry`.
   * @param {Record<string,string>} files filename -> source
   */
  async runProject(files, entry = 'main.py') {
    this._assertBooted();
    const py = this.pyodide.toPy(files);
    try {
      return toJs(await this.session.run_project(py, entry));
    } finally {
      py.destroy();
    }
  }

  _withPyFiles(files, fn) {
    const py = this.pyodide.toPy(files);
    try {
      return fn(py);
    } finally {
      py.destroy();
    }
  }

  /**
   * Transform and execute. Resolves when the program finishes, errors, or is
   * stopped - never rejects for ordinary student mistakes.
   */
  async run(source) {
    this._assertBooted();
    return toJs(await this.session.run(source));
  }

  /** Cancel the running program. */
  stop() {
    if (!this.booted) return false;
    return this.session.stop();
  }

  isRunning() {
    return this.booted ? this.session.is_running() : false;
  }

  _assertBooted() {
    if (!this.booted) throw new Error('runtime is not booted yet');
  }
}

/**
 * Guarantee `.wasm` arrives as `application/wasm`.
 *
 * Pyodide's browser loader is hard-wired to `WebAssembly.instantiateStreaming`:
 *
 *   function browser_getBinaryResponse(url, integrity) {
 *     return { response: fetch(new URL(url, location), ...) };
 *   }
 *
 * It never populates the `binary` branch, and the surrounding try/catch only
 * logs "wasm instantiation failed!" - there is no ArrayBuffer fallback. So on
 * any host that mislabels .wasm, boot dies silently at the loading screen.
 *
 * Static hosts vary here and several (GitHub Pages among them) give you no way
 * to set response headers. Rather than depend on the host, re-wrap the response
 * with the right type. Streaming is preserved on correctly configured hosts,
 * because we only intervene when the type is actually wrong.
 */
let wasmMimeFixInstalled = false;

/**
 * Does this fetch target a .wasm file?
 *
 * Pyodide calls `fetch(new URL(path, location))`, so the argument is a URL
 * object - not a string, and not a Request either. Reading `.url` on it yields
 * undefined, so the type has to be handled explicitly.
 */
function isWasmRequest(input) {
  let href;
  if (typeof input === 'string') href = input;
  else if (input instanceof URL) href = input.href;
  else if (typeof input?.url === 'string') href = input.url;
  else href = String(input ?? '');

  try {
    return new URL(href, location.href).pathname.endsWith('.wasm');
  } catch {
    return href.split(/[?#]/)[0].endsWith('.wasm');
  }
}

export function installWasmMimeFix() {
  if (wasmMimeFixInstalled || typeof globalThis.fetch !== 'function') return;
  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function patchedFetch(input, init) {
    const response = await original(input, init);
    if (!response.ok || !isWasmRequest(input)) return response;

    const type = response.headers.get('content-type') ?? '';
    if (type.split(';')[0].trim() === 'application/wasm') return response;

    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'application/wasm');
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  wasmMimeFixInstalled = true;
}

/** Convert a Python return value to plain JS, releasing the proxy. */
function toJs(value) {
  if (value && typeof value.toJs === 'function') {
    const js = value.toJs({ dict_converter: Object.fromEntries });
    value.destroy();
    return js;
  }
  return value;
}
