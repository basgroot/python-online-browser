import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';

/**
 * CodeMirror 6 wrapper supporting several files.
 *
 * One EditorView is reused, but each file keeps its own EditorState. That
 * matters because state carries undo history and cursor position: swapping
 * only the document text would merge every file's edits into a single undo
 * stack, so undoing in one file could rewrite another.
 */
export function createEditor({ parent, files = {}, active, onChange, onRun }) {
  const editable = new Compartment();
  const states = new Map();
  let current = active ?? Object.keys(files)[0] ?? 'main.py';
  let isEditable = true;

  const extensions = () => [
    basicSetup,
    python(),
    oneDark,
    indentUnit.of('    '),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => {
          onRun?.();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange?.(current, update.state.doc.toString());
    }),
    editable.of(EditorView.editable.of(isEditable)),
  ];

  const makeState = (doc) => EditorState.create({ doc, extensions: extensions() });

  for (const [name, source] of Object.entries(files)) {
    states.set(name, makeState(source));
  }
  if (!states.has(current)) states.set(current, makeState(''));

  const view = new EditorView({ parent, state: states.get(current) });

  function stash() {
    states.set(current, view.state);
  }

  return {
    view,
    get activeFile() {
      return current;
    },
    getValue: () => view.state.doc.toString(),

    /** Current text of any file, live for the active one. */
    getFile(name) {
      if (name === current) return view.state.doc.toString();
      return states.get(name)?.doc.toString() ?? null;
    },

    getAllFiles() {
      stash();
      const out = {};
      for (const [name, state] of states) out[name] = state.doc.toString();
      return out;
    },

    switchTo(name) {
      if (name === current) return;
      stash();
      if (!states.has(name)) states.set(name, makeState(''));
      current = name;
      view.setState(states.get(name));
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(isEditable)) });
    },

    addFile(name, source = '') {
      states.set(name, makeState(source));
    },

    removeFile(name) {
      states.delete(name);
    },

    renameFile(from, to) {
      if (!states.has(from)) return;
      // Rebuild the map so tab order is preserved rather than moving to the end.
      const rebuilt = new Map();
      for (const [name, state] of states) rebuilt.set(name === from ? to : name, state);
      states.clear();
      for (const [name, state] of rebuilt) states.set(name, state);
      if (current === from) current = to;
    },

    /** Replace every file, e.g. when loading an example or a shared link. */
    setFiles(next, activeName) {
      states.clear();
      for (const [name, source] of Object.entries(next)) states.set(name, makeState(source));
      current = activeName && states.has(activeName) ? activeName : Object.keys(next)[0];
      view.setState(states.get(current));
    },

    setValue(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
      });
    },

    setEditable(on) {
      isEditable = on;
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(on)) });
    },

    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
