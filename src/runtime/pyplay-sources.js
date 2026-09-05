// The pyplay package is authored as real .py files (so pytest and pyright can
// see them) but inlined into the bundle at build time, so the app needs no
// extra round trips and works offline once cached.
import initPy from '../../python/pyplay/__init__.py?raw';
import runtimePy from '../../python/pyplay/runtime.py?raw';
import transformPy from '../../python/pyplay/transform.py?raw';
import sessionPy from '../../python/pyplay/session.py?raw';

export const PYPLAY_SOURCES = {
  '__init__.py': initPy,
  'runtime.py': runtimePy,
  'transform.py': transformPy,
  'session.py': sessionPy,
};
