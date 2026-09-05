/**
 * The in-memory project: a flat set of .py files with `main.py` as the entry
 * point. Flat rather than nested on purpose - packages and relative imports
 * add a lot of concepts for very little benefit at this level.
 */

export const ENTRY = 'main.py';

/** Reserved because shadowing them breaks `import pygame` in confusing ways. */
const RESERVED = new Set([
  'pygame.py', 'asyncio.py', 'time.py', 'random.py', 'math.py',
  'sys.py', 'os.py', 'json.py', 'types.py', 'string.py',
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*\.py$/;

/**
 * Validate a filename. Returns an error string, or null when acceptable.
 * The rules mirror what Python can actually import: a module name has to be a
 * valid identifier, so "my game.py" or "2048.py" cannot work.
 */
export function validateFileName(name, existing = []) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'Give the file a name.';
  if (!trimmed.endsWith('.py')) return 'File names must end in .py';
  if (!NAME_RE.test(trimmed)) {
    return 'Use letters, numbers and underscores only, starting with a letter.';
  }
  if (RESERVED.has(trimmed)) return `${trimmed} is the name of a Python module. Pick another.`;
  if (existing.includes(trimmed)) return `${trimmed} already exists.`;
  return null;
}

export function createProject(files = null) {
  const initial = files ?? { [ENTRY]: '' };
  return { files: { ...initial }, active: ENTRY };
}

export const fileNames = (project) => Object.keys(project.files);

/** main.py first, then the rest alphabetically - a stable, predictable order. */
export function orderedFileNames(project) {
  return Object.keys(project.files).sort((a, b) => {
    if (a === ENTRY) return -1;
    if (b === ENTRY) return 1;
    return a.localeCompare(b);
  });
}

export function addFile(project, name, source = '') {
  const error = validateFileName(name, fileNames(project));
  if (error) return { ok: false, error };
  return {
    ok: true,
    project: { files: { ...project.files, [name]: source }, active: name },
  };
}

export function deleteFile(project, name) {
  if (name === ENTRY) return { ok: false, error: `${ENTRY} cannot be deleted.` };
  if (!(name in project.files)) return { ok: false, error: `${name} does not exist.` };
  const files = { ...project.files };
  delete files[name];
  return {
    ok: true,
    project: { files, active: project.active === name ? ENTRY : project.active },
  };
}

export function renameFile(project, from, to) {
  if (from === ENTRY) return { ok: false, error: `${ENTRY} cannot be renamed.` };
  const error = validateFileName(to, fileNames(project).filter((n) => n !== from));
  if (error) return { ok: false, error };

  // Preserve insertion order so the tab does not jump while renaming.
  const files = {};
  for (const [name, source] of Object.entries(project.files)) {
    files[name === from ? to : name] = source;
  }
  return {
    ok: true,
    project: { files, active: project.active === from ? to : project.active },
  };
}

export function setSource(project, name, source) {
  if (!(name in project.files)) return project;
  return { ...project, files: { ...project.files, [name]: source } };
}

export const isMultiFile = (project) => Object.keys(project.files).length > 1;
