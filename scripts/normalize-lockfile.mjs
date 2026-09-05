#!/usr/bin/env node
/**
 * Rewrite package-lock.json `resolved` URLs to the public npm registry.
 *
 * Installing from behind a corporate Artifactory mirror bakes internal hosts
 * such as `artifacts.sys.dom` into the lockfile. Those hosts do not resolve
 * from GitHub Actions runners, so `npm ci` fails there.
 *
 * Rewriting is safe: `integrity` is a hash of the tarball contents, and the
 * mirror proxies the very same tarballs, so the hashes still verify.
 *
 * Usage:
 *   node scripts/normalize-lockfile.mjs          rewrite in place
 *   node scripts/normalize-lockfile.mjs --check  exit 1 if any internal host remains
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

// host[:port] + Artifactory npm repo path -> public registry root
const MIRRORS = [
  /^https?:\/\/artifacts\.sys\.dom(?::\d+)?\/artifactory\/api\/npm\/[^/]+\//,
  /^https?:\/\/artifacts\.cf\.saxo(?::\d+)?\/artifactory\/api\/npm\/[^/]+\//,
];

const INTERNAL = /artifacts\.sys\.dom|artifacts\.cf\.saxo/;

const file = 'package-lock.json';
const checkOnly = process.argv.includes('--check');
const original = readFileSync(file, 'utf8');

let rewritten = 0;
const normalized = original.replace(/"resolved":\s*"([^"]+)"/g, (match, url) => {
  for (const mirror of MIRRORS) {
    if (mirror.test(url)) {
      rewritten++;
      return `"resolved": "${url.replace(mirror, PUBLIC_REGISTRY)}"`;
    }
  }
  return match;
});

if (checkOnly) {
  const remaining = original.match(new RegExp(INTERNAL, 'g'))?.length ?? 0;
  if (remaining) {
    console.error(
      `package-lock.json references ${remaining} internal registry URL(s).\n` +
        'These are unreachable from CI. Run: node scripts/normalize-lockfile.mjs',
    );
    process.exit(1);
  }
  console.log('package-lock.json: no internal registry URLs');
  process.exit(0);
}

// Sanity check before writing: the result must still be valid JSON.
JSON.parse(normalized);
writeFileSync(file, normalized);
console.log(
  rewritten
    ? `Rewrote ${rewritten} resolved URL(s) to ${PUBLIC_REGISTRY}`
    : 'Nothing to rewrite; lockfile already uses the public registry',
);
