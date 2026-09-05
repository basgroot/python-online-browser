"""Drives one execution of a student's program inside the browser.

Responsibilities:

* transform the source so it cannot freeze the tab
* execute it as a cancellable asyncio task, so Stop actually works
* register the *original* source with linecache so tracebacks quote the line
  the student wrote
* strip our own frames out of tracebacks, so errors read as if the program ran
  on its own
"""

from __future__ import annotations

import ast
import asyncio
import builtins
import importlib.util
import inspect
import linecache
import os
import shutil
import sys
import traceback
import types

from . import runtime
from .transform import (
    DEFAULT_FILENAME,
    HELPERS,
    CircularImport,
    compile_module,
    has_top_level_await,
    import_order,
    module_name,
    transform_project,
)

ENTRY = "main.py"
PROJECT_DIR = "/home/pyodide/project"

_current: asyncio.Future | None = None
_last_warnings: list = []
_project_files: set = set()
_owned_modules: set = set()


def _install_source(source: str, filename: str) -> None:
    """Make the original source visible to traceback/linecache."""
    linecache.cache[filename] = (
        len(source),
        None,
        source.splitlines(keepends=True),
        filename,
    )


def _fresh_globals(name: str = "__main__") -> dict:
    g: dict = {name_: getattr(runtime, name_) for name_ in HELPERS}
    g["__name__"] = name
    g["__builtins__"] = builtins
    return g


def _forget_project_modules() -> None:
    """Drop previously executed project modules so a re-run starts clean."""
    for name in _owned_modules:
        sys.modules.pop(name, None)
    _owned_modules.clear()
    _remove_finders()


class _ProjectLoader:
    """Executes a project module from a code object we already compiled.

    Using the real import machinery matters: a helper must run at the moment
    main.py imports it, not before. Code like

        pygame.display.set_mode(...)
        import chesspieces      # loads images, needs the display

    breaks if the helper is executed eagerly, because there is no display yet.
    Executing our own precompiled code object (rather than letting Python
    recompile the file) also keeps the original line numbers, so tracebacks
    still point at what the student wrote.
    """

    def __init__(self, name: str, filename: str, code):
        self.name = name
        self.filename = filename
        self.code = code

    def create_module(self, spec):
        return None  # default module creation

    def exec_module(self, module) -> None:
        module.__file__ = self.filename
        for helper in HELPERS:
            setattr(module, helper, getattr(runtime, helper))
        _owned_modules.add(module.__name__)

        if self.code.co_flags & inspect.CO_COROUTINE:
            raise ImportError(
                f"{self.filename} runs a loop at the top level, so it cannot be "
                f"imported. Move that code inside a function and call it from "
                f"{ENTRY}."
            )
        exec(self.code, module.__dict__)  # noqa: S102 - our own compiled AST


class _ProjectFinder:
    """Serves project modules to `import`, ignoring everything else."""

    def __init__(self, modules: dict):
        self.modules = modules

    def find_spec(self, fullname, path=None, target=None):
        entry = self.modules.get(fullname)
        if entry is None:
            return None
        filename, code = entry
        loader = _ProjectLoader(fullname, filename, code)
        # spec_from_loader's protocol expects a legacy load_module; create_module
        # plus exec_module is the modern equivalent, so silence the check.
        return importlib.util.spec_from_loader(fullname, loader, origin=filename)  # type: ignore[arg-type]


def _install_finder(finder) -> None:
    _remove_finders()
    sys.meta_path.insert(0, finder)


def _remove_finders() -> None:
    sys.meta_path[:] = [f for f in sys.meta_path if not isinstance(f, _ProjectFinder)]


async def _exec_awaiting_module(name: str, filename: str, code) -> None:
    """Run a helper that needs top-level await, before the entry point.

    The import machinery cannot await, so such modules are executed eagerly.
    That changes their timing relative to plain Python, hence the warning.
    """
    module = types.ModuleType(name)
    module.__file__ = filename
    module.__dict__.update(_fresh_globals(name))
    module.__dict__["__name__"] = name

    sys.modules[name] = module
    _owned_modules.add(name)

    outcome = eval(code, module.__dict__)  # noqa: S307 - our own compiled AST
    if inspect.isawaitable(outcome):
        await outcome


def format_exception(exc: BaseException, filename: str = DEFAULT_FILENAME) -> str:
    """Render a traceback containing only the student's own frames.

    In a multi-file project every file the student wrote counts as "their own",
    so a traceback can legitimately span main.py and its helpers.
    """
    if isinstance(exc, SyntaxError):
        return "".join(traceback.format_exception_only(type(exc), exc)).strip()

    owned = _project_files | {filename}

    tb = exc.__traceback__
    frames = []
    while tb is not None:
        if tb.tb_frame.f_code.co_filename in owned:
            frames.append(tb)
        tb = tb.tb_next

    lines = ["Traceback (most recent call last):"]
    if frames:
        for entry in traceback.StackSummary.extract(
            ((f.tb_frame, f.tb_lineno) for f in frames), capture_locals=False
        ).format():
            lines.append(entry.rstrip("\n"))
    else:
        # Everything was internal; fall back to the full trace rather than
        # showing the student nothing at all.
        lines = ["Traceback (most recent call last):"]
        lines.extend(
            line.rstrip("\n")
            for line in traceback.format_tb(exc.__traceback__)
        )

    lines.extend(
        line.rstrip("\n")
        for line in traceback.format_exception_only(type(exc), exc)
    )
    return "\n".join(lines)


def prepare(source: str, filename: str = DEFAULT_FILENAME) -> dict:
    """Transform without running. Used for pre-flight checks in the editor."""
    return prepare_project({filename: source}, entry=filename)


def prepare_project(files: dict, entry: str = ENTRY) -> dict:
    """Check a whole project compiles, without running any of it."""
    files = dict(files)
    if entry not in files:
        return {"ok": False, "error": f"No {entry} found.", "warnings": []}
    try:
        compiled = _compile_project(files, entry)
    except SyntaxError as exc:
        return {"ok": False, "error": format_exception(exc, entry), "warnings": []}
    except CircularImport as exc:
        return {"ok": False, "error": str(exc), "warnings": []}

    warnings = [
        f"{filename}: {w}" if len(files) > 1 else str(w)
        for _mod, filename, _code, result in compiled
        for w in result.warnings
    ]
    return {
        "ok": True,
        "error": None,
        "warnings": warnings,
        "modules": [mod for mod, _f, _c, _r in compiled],
        "changed": any(result.changed for *_x, result in compiled),
    }


def _sync_to_filesystem(files: dict) -> None:
    """Mirror the project onto the virtual filesystem.

    Not needed to execute the code - modules are executed directly - but it
    makes ordinary things work: open('data.txt'), loading images next to the
    script, and inspecting __file__.
    """
    try:
        if os.path.isdir(PROJECT_DIR):
            shutil.rmtree(PROJECT_DIR)
        os.makedirs(PROJECT_DIR, exist_ok=True)
        for name, source in files.items():
            if "/" in name or "\\" in name:
                continue
            with open(os.path.join(PROJECT_DIR, name), "w", encoding="utf-8") as handle:
                handle.write(source)
        os.chdir(PROJECT_DIR)
        if PROJECT_DIR not in sys.path:
            sys.path.insert(0, PROJECT_DIR)
    except OSError:
        # Running outside the browser sandbox (e.g. the CPython test suite).
        pass


def _compile_project(files: dict, entry: str):
    """Transform, order by imports, and compile every file."""
    results = transform_project(files)

    by_module = {module_name(name): name for name in files}
    trees = {module_name(name): results[name].tree for name in files}
    order = import_order(trees, module_name(entry))

    compiled = []
    for mod in order:
        filename = by_module[mod]
        result = results[filename]
        code = compile(
            result.tree,
            filename,
            "exec",
            flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
        )
        compiled.append((mod, filename, code, result))
    return compiled


async def _execute(files: dict, entry: str) -> None:
    compiled = _compile_project(files, entry)

    global _last_warnings
    _last_warnings = [
        f"{filename}: {w}" if len(files) > 1 else str(w)
        for _mod, filename, _code, result in compiled
        for w in result.warnings
    ]

    entry_module = module_name(entry)
    servable: dict = {}

    for mod, filename, code, _result in compiled:
        if mod == entry_module:
            continue
        if code.co_flags & inspect.CO_COROUTINE:
            # Needs top-level await, which `import` cannot do, so run it now.
            _last_warnings.append(
                f"{filename}: has a loop outside any function, so it runs before {entry}."
            )
            await _exec_awaiting_module(mod, filename, code)
        else:
            servable[mod] = (filename, code)

    # Everything else is imported normally, at the point main.py asks for it.
    _install_finder(_ProjectFinder(servable))
    try:
        for mod, _filename, code, _result in compiled:
            if mod != entry_module:
                continue
            g = _fresh_globals("__main__")
            outcome = eval(code, g)  # noqa: S307 - we compiled this AST ourselves
            if inspect.isawaitable(outcome):
                await outcome
    finally:
        _remove_finders()


async def run(source: str, filename: str = DEFAULT_FILENAME) -> dict:
    """Transform and execute a single file."""
    return await run_project({filename: source}, entry=filename)


async def run_project(files: dict, entry: str = ENTRY) -> dict:
    """Transform and execute a whole project, starting at *entry*."""
    global _current, _project_files

    files = dict(files)
    if entry not in files:
        return {
            "status": "error",
            "error": f"No {entry} found. The program starts at {entry}.",
            "warnings": [],
        }

    stop()
    _forget_project_modules()
    runtime.reset()
    install_report = runtime.install()

    _project_files = set(files)
    for name, source in files.items():
        _install_source(source, name)
    _sync_to_filesystem(files)

    try:
        _compile_project(files, entry)
    except SyntaxError as exc:
        return {
            "status": "error",
            "error": format_exception(exc, entry),
            "warnings": [],
            "patches": install_report,
        }
    except CircularImport as exc:
        return {
            "status": "error",
            "error": str(exc),
            "warnings": [],
            "patches": install_report,
        }

    task = asyncio.ensure_future(_execute(files, entry))
    _current = task
    filename = entry

    try:
        await task
    except asyncio.CancelledError:
        return {"status": "stopped", "error": None, "warnings": _last_warnings}
    except BaseException as exc:  # noqa: BLE001 - surfaced to the student
        return {
            "status": "error",
            "error": format_exception(exc, filename),
            "warnings": _last_warnings,
            "patches": install_report,
        }
    finally:
        if _current is task:
            _current = None
        _cancel_timers()

    return {
        "status": "finished",
        "error": None,
        "warnings": _last_warnings,
        "patches": install_report,
        "frames": runtime.state.get("frames", 0),
    }


def _cancel_timers() -> None:
    cancel = runtime.state.get("cancel_timers")
    if callable(cancel):
        try:
            cancel()
        except Exception:
            pass


def stop() -> bool:
    """Cancel the running program. Returns True if something was cancelled."""
    global _current
    _cancel_timers()
    task = _current
    _current = None
    if task is not None and not task.done():
        task.cancel()
        return True
    return False


def is_running() -> bool:
    return _current is not None and not _current.done()


def diagnostics() -> dict:
    return {
        "python": sys.version.split()[0],
        "running": is_running(),
        "frames": runtime.state.get("frames", 0),
    }
