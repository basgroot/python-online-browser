import { PythonRuntime } from './runtime/index.js';
import { PYPLAY_SOURCES } from './runtime/pyplay-sources.js';
import { createEditor } from './editor/editor.js';
import { EXAMPLES, DEFAULT_EXAMPLE, findExample } from './examples/index.js';
import { buildShareUrl, decodeProject, readFragment, isEmbedded } from './share/url.js';
import {
  ENTRY,
  addFile,
  createProject,
  deleteFile,
  orderedFileNames,
  renameFile,
  validateFileName,
} from './project/project.js';

const STORAGE_KEY = 'pyplay.project.v2';
const LEGACY_KEY = 'pyplay.draft.v1';

const el = {
  body: document.body,
  run: document.getElementById('run'),
  stop: document.getElementById('stop'),
  share: document.getElementById('share'),
  examples: document.getElementById('examples'),
  status: document.getElementById('status'),
  console: document.getElementById('console'),
  clearConsole: document.getElementById('clear-console'),
  canvas: document.getElementById('canvas'),
  bootText: document.getElementById('boot-text'),
  tabs: document.getElementById('tabs'),
  addFile: document.getElementById('add-file'),
};

// ---------------------------------------------------------------- console

function emit(text, kind = '') {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = text;
  el.console.appendChild(line);
  el.console.scrollTop = el.console.scrollHeight;
}

const clearConsole = () => { el.console.textContent = ''; };

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = kind;
}

// ---------------------------------------------------------------- storage

let project = createProject(DEFAULT_EXAMPLE.files);

function saveProject() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ files: editor ? editor.getAllFiles() : project.files, active: project.active }),
    );
  } catch { /* private browsing */ }
}

function loadStoredProject() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.files && Object.keys(parsed.files).length) return parsed;
    }
    // Migrate a single-file draft saved before multi-file support.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && legacy.trim()) return { files: { [ENTRY]: legacy }, active: ENTRY };
  } catch { /* ignore corrupt storage */ }
  return null;
}

/** A shared link wins, then the saved project, then the default example. */
async function resolveInitialProject() {
  const shared = await decodeProject(readFragment());
  if (shared) return { ...shared, origin: 'link' };

  const stored = loadStoredProject();
  if (stored) return { ...stored, origin: 'storage' };

  return { files: { ...DEFAULT_EXAMPLE.files }, active: ENTRY, origin: 'example' };
}

// ------------------------------------------------------------------ tabs

/**
 * The editor owns which file is showing. Keeping a second copy on `project`
 * lets the two drift apart, which silently breaks tab switching, so always
 * ask the editor once it exists.
 */
function activeFile() {
  return editor ? editor.activeFile : project.active;
}

function renderTabs() {
  el.tabs.textContent = '';
  const names = orderedFileNames(project);
  const current = activeFile();

  for (const name of names) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.type = 'button';
    tab.role = 'tab';
    tab.dataset.file = name;
    tab.setAttribute('aria-selected', String(name === current));

    if (name === ENTRY) {
      const dot = document.createElement('span');
      dot.className = 'entry-dot';
      dot.title = 'The program starts here';
      tab.appendChild(dot);
    }

    tab.appendChild(document.createTextNode(name));
    tab.addEventListener('click', () => switchTo(name));
    if (name !== ENTRY) {
      tab.addEventListener('dblclick', () => promptRename(name));

      const close = document.createElement('span');
      close.className = 'close';
      close.role = 'button';
      close.textContent = '\u00d7';
      close.title = `Delete ${name}`;
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        promptDelete(name);
      });
      tab.appendChild(close);
    }

    el.tabs.appendChild(tab);
  }
}

function switchTo(name) {
  if (!(name in project.files) || name === activeFile()) return;
  editor.switchTo(name);
  project.active = editor.activeFile;
  renderTabs();
  editor.focus();
}

function promptAddFile() {
  const name = window.prompt('New file name (must end in .py):', 'helper.py');
  if (name === null) return;

  const result = addFile(project, name.trim(), '');
  if (!result.ok) {
    setStatus(result.error, 'error');
    return;
  }
  project = result.project;
  editor.addFile(project.active, '');
  editor.switchTo(project.active);
  renderTabs();
  saveProject();
  setStatus(`Created ${project.active}. Import it with: import ${project.active.replace(/\.py$/, '')}`, 'ok');
  editor.focus();
}

function promptRename(name) {
  const next = window.prompt(`Rename ${name} to:`, name);
  if (next === null || next.trim() === name) return;

  const result = renameFile(project, name, next.trim());
  if (!result.ok) {
    setStatus(result.error, 'error');
    return;
  }
  editor.renameFile(name, next.trim());
  project = result.project;
  renderTabs();
  saveProject();
  setStatus(`Renamed to ${next.trim()}. Update your import statements.`, 'ok');
}

function promptDelete(name) {
  if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;

  const result = deleteFile(project, name);
  if (!result.ok) {
    setStatus(result.error, 'error');
    return;
  }
  editor.removeFile(name);
  project = result.project;
  editor.switchTo(project.active);
  renderTabs();
  saveProject();
  setStatus(`Deleted ${name}`);
}

// ------------------------------------------------------------------ setup

const embedded = isEmbedded();
if (embedded) el.body.classList.add('embed');

for (const example of EXAMPLES) {
  const option = document.createElement('option');
  option.value = example.id;
  option.textContent = example.title;
  el.examples.appendChild(option);
}

const initial = await resolveInitialProject();
project = { files: initial.files, active: initial.active ?? ENTRY };
if (!(project.active in project.files)) project.active = ENTRY;
if (initial.origin === 'example') el.examples.value = DEFAULT_EXAMPLE.id;

const editor = createEditor({
  parent: document.getElementById('editor'),
  files: project.files,
  active: project.active,
  onChange: (name, source) => {
    project.files[name] = source;
    saveProject();
  },
  onRun: () => run(),
});

renderTabs();

// Vite substitutes BASE_URL at build time and always includes a trailing
// slash, so this resolves correctly whether the site is served from a domain
// root or from a GitHub Pages subpath like /python-web/.
const BASE = import.meta.env.BASE_URL;

const runtime = new PythonRuntime({
  canvas: el.canvas,
  indexURL: `${BASE}vendor/pyodide/`,
  pyplaySources: PYPLAY_SOURCES,
  onStdout: (s) => emit(s),
  onStderr: (s) => emit(s, 'err'),
  onStatus: (stage, detail) => onBootStage(stage, detail),
});

const BOOT_LABELS = {
  'loading-runtime': 'Downloading Python\u2026',
  'binding-canvas': 'Preparing the display\u2026',
  'loading-pygame': 'Loading pygame\u2026',
  'installing-pyplay': 'Almost ready\u2026',
};

function onBootStage(stage, detail) {
  if (stage === 'ready') {
    el.body.classList.remove('booting');
    el.run.disabled = false;
    setStatus(`Ready in ${(detail.totalMs / 1000).toFixed(1)}s`, 'ok');
    if (embedded) run();
    return;
  }
  el.bootText.textContent = BOOT_LABELS[stage] ?? stage;
  setStatus(BOOT_LABELS[stage] ?? stage);
}

// -------------------------------------------------------------------- run

let running = false;

function setRunning(on) {
  running = on;
  el.run.disabled = on;
  el.stop.disabled = !on;
  el.addFile.disabled = on;
  editor.setEditable(!on);
}

async function run() {
  if (running || !runtime.booted) return;

  const files = editor.getAllFiles();
  project.files = files;
  // Persist *before* executing: if a pathological program wedges the tab, the
  // student's work still survives a reload.
  saveProject();

  clearConsole();
  setRunning(true);
  setStatus('Running\u2026');

  // SDL only listens for keys on the canvas, so give it focus up front.
  // Otherwise the student has to click the display before the arrow keys work.
  el.canvas.focus();

  const result = await runtime.runProject(files, ENTRY);

  setRunning(false);

  for (const warning of result.warnings ?? []) emit(`Warning: ${warning}`, 'warn');

  if (result.status === 'error') {
    emit(result.error, 'err');
    setStatus('Stopped with an error', 'error');
  } else if (result.status === 'stopped') {
    emit('Stopped.', 'note');
    setStatus('Stopped');
  } else {
    emit('Program finished.', 'note');
    setStatus('Finished', 'ok');
  }

  el.canvas.focus();
}

function stop() {
  runtime.stop();
  setStatus('Stopping\u2026');
}

// ---------------------------------------------------------------- wiring

el.run.addEventListener('click', () => run());
el.stop.addEventListener('click', () => stop());
el.clearConsole.addEventListener('click', clearConsole);
el.addFile.addEventListener('click', promptAddFile);

el.examples.addEventListener('change', () => {
  const example = findExample(el.examples.value);
  if (!example) return;
  if (running) stop();

  project = createProject(example.files);
  editor.setFiles(project.files, ENTRY);
  renderTabs();
  saveProject();
  clearConsole();
  // A stale share link would misrepresent what is now in the editor.
  history.replaceState(null, '', location.pathname + location.search);
  editor.focus();
});

el.share.addEventListener('click', async () => {
  const url = await buildShareUrl(editor.getAllFiles());
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Share link copied to clipboard', 'ok');
  } catch {
    setStatus('Share link is in the address bar', 'ok');
  }
});

// Keep focus in the canvas while a game is running so keys reach pygame.
el.canvas.addEventListener('mousedown', () => el.canvas.focus());

// Ctrl/Cmd+Enter should run from anywhere, not only from inside the editor -
// students often press it while the canvas has focus.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  if (running) stop();
  else run();
});

window.addEventListener('beforeunload', saveProject);

// Exposed for the end-to-end tests.
window.pyplayApp = {
  runtime,
  editor,
  run,
  stop,
  isRunning: () => running,
  getFiles: () => editor.getAllFiles(),
  getProject: () => project,
  addFile: (name, source = '') => {
    const result = addFile(project, name, source);
    if (!result.ok) return result;
    project = result.project;
    editor.addFile(name, source);
    editor.switchTo(name);
    renderTabs();
    saveProject();
    return result;
  },
  validateFileName: (name) => validateFileName(name, Object.keys(project.files)),
};

// Start downloading immediately; boot is the slowest thing we do (Firefox is
// noticeably slower than Chromium here), so it should overlap with the student
// reading or typing rather than starting when they press Run.
runtime.boot().catch((err) => {
  el.body.classList.remove('booting');
  setStatus('Python failed to start', 'error');
  emit(String(err), 'err');
});
