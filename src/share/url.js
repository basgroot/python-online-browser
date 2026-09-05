/**
 * Share links with no backend.
 *
 * The program is deflated and base64url-encoded into the URL *fragment*.
 * Fragments are never transmitted to a server, so shared code stays private
 * to whoever holds the link, and the whole site can remain static.
 *
 * Format: `#<scheme>.<payload>` where scheme is `c1` (deflate-raw) or `p1`
 * (plain UTF-8) for browsers without CompressionStream.
 */

// c1/p1 carry a single program; c2/p2 carry a whole multi-file project as
// JSON. The older schemes are still decoded so links shared before multi-file
// support existed keep working.
const COMPRESSED = 'c1';
const PLAIN = 'p1';
const PROJECT_COMPRESSED = 'c2';
const PROJECT_PLAIN = 'p2';

export const ENTRY = 'main.py';

const hasCompression =
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, stream) {
  const blob = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

async function pack(text, compressedScheme, plainScheme) {
  const bytes = new TextEncoder().encode(text);
  if (!hasCompression) return `${plainScheme}.${toBase64Url(bytes)}`;
  const deflated = await pipe(bytes, new CompressionStream('deflate-raw'));
  return `${compressedScheme}.${toBase64Url(deflated)}`;
}

/** Encode a single program into a URL fragment payload (no leading '#'). */
export const encode = (source) => pack(source, COMPRESSED, PLAIN);

/** Encode a whole project (filename -> source). */
export const encodeProject = (files) =>
  pack(JSON.stringify({ v: 1, files }), PROJECT_COMPRESSED, PROJECT_PLAIN);

async function unpack(scheme, payload) {
  const bytes = fromBase64Url(payload);
  if (scheme === PLAIN || scheme === PROJECT_PLAIN) return new TextDecoder().decode(bytes);
  if (!hasCompression) throw new Error('this browser cannot read compressed links');
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')));
}

/**
 * Decode a fragment into `{ files, active }`, or null if it is not ours.
 * Single-file links are widened into a one-file project.
 */
export async function decodeProject(fragment) {
  if (!fragment) return null;
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;

  const scheme = raw.slice(0, dot);
  const payload = raw.slice(dot + 1);
  if (!payload) return null;

  try {
    const text = await unpack(scheme, payload);
    if (scheme === COMPRESSED || scheme === PLAIN) {
      return { files: { [ENTRY]: text }, active: ENTRY };
    }
    if (scheme === PROJECT_COMPRESSED || scheme === PROJECT_PLAIN) {
      const parsed = JSON.parse(text);
      const files = parsed?.files;
      if (!files || typeof files !== 'object') return null;
      // Ignore anything that is not a plain string, and guarantee an entry file.
      const clean = {};
      for (const [name, source] of Object.entries(files)) {
        if (typeof source === 'string') clean[name] = source;
      }
      if (!Object.keys(clean).length) return null;
      if (!(ENTRY in clean)) clean[ENTRY] = '';
      return { files: clean, active: ENTRY };
    }
  } catch {
    return null;
  }
  return null;
}

/** Backwards-compatible single-program decode. */
export async function decode(fragment) {
  const project = await decodeProject(fragment);
  return project ? (project.files[ENTRY] ?? null) : null;
}

/** Build a full shareable URL for a project. */
export async function buildShareUrl(files, { embed = false, base = location.href } = {}) {
  const project = typeof files === 'string' ? { [ENTRY]: files } : files;
  const names = Object.keys(project);
  const single = names.length === 1 && names[0] === ENTRY;

  const url = new URL(base);
  url.hash = single ? await encode(project[ENTRY]) : await encodeProject(project);
  if (embed) url.searchParams.set('embed', '1');
  else url.searchParams.delete('embed');
  return url.toString();
}

/** Read the program from the current URL, if any. */
export function readFragment() {
  return location.hash ? location.hash.slice(1) : null;
}

export const isEmbedded = () => new URLSearchParams(location.search).get('embed') === '1';
