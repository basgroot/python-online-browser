// Simulates a GitHub Pages *project* site: the built app is served from a
// subpath (https://user.github.io/<repo>/) rather than a domain root.
//
// It is deliberately stricter than GitHub Pages in one respect: .wasm is served
// as application/octet-stream instead of application/wasm. GitHub Pages does
// send the correct type, but serving the wrong one here proves Pyodide's
// documented fallback from instantiateStreaming to ArrayBuffer instantiation
// actually works, so a MIME surprise on any host cannot break the site.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const ROOT = join(REPO, process.env.SUBPATH_DIR ?? 'dist-ghpages');
const PREFIX = process.env.SUBPATH_PREFIX ?? '/python-web/';
const PORT = Number(process.env.SUBPATH_PORT ?? 4174);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/octet-stream', // intentionally wrong; see above
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);

    if (!path.startsWith(PREFIX)) {
      // Anything outside the prefix does not exist, exactly as on Pages.
      res.writeHead(404).end('not found (outside project subpath)');
      return;
    }

    path = path.slice(PREFIX.length - 1);
    if (path.endsWith('/')) path += 'index.html';

    const filePath = normalize(join(ROOT, path));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // GitHub Pages does not let you set custom headers; it sends a short
      // max-age plus an ETag. Mirror that rather than our own _headers rules.
      'Cache-Control': 'max-age=600',
    });
    res.end(await readFile(filePath));
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
}).listen(PORT, () => {
  console.log(`github-pages simulation: http://localhost:${PORT}${PREFIX} (root=${ROOT})`);
});
