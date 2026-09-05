// Minimal static file server for the Phase 0 spike.
// Serves the repo root with correct MIME types for wasm/mjs/whl,
// and optional COOP/COEP isolation (needed later for SharedArrayBuffer).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT ?? 8123);
const ISOLATE = process.env.COOP_COEP === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.py': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Resolve against public/ first (mirroring Vite's publicDir), then the
    // repo root so source files like /src/... and /python/... stay reachable.
    let filePath = null;
    let info = null;
    for (const base of [join(ROOT, 'public'), ROOT]) {
      const candidate = normalize(join(base, path));
      if (!candidate.startsWith(base)) continue; // contain path traversal
      const found = await stat(candidate).catch(() => null);
      if (found?.isFile()) {
        filePath = candidate;
        info = found;
        break;
      }
    }

    if (!filePath || !info) {
      res.writeHead(404).end('not found');
      return;
    }

    const headers = {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      // Required by Pyodide when cross-origin isolated.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (ISOLATE) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }

    res.writeHead(200, headers);
    res.end(await readFile(filePath));
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`spike server: http://localhost:${PORT}/  (root=${ROOT}, isolated=${ISOLATE})`);
});
