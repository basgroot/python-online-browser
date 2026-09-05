"""Rewrite ordinary blocking pygame code into browser-safe async code.

The browser has one thread. A ``while True:`` game loop written the way every
pygame tutorial writes it never returns control to the event loop, so the tab
freezes: rendering stops, input stops, and the Stop button cannot even be
clicked. Phase 0 test T10 confirms this empirically.

This module rewrites the user's AST so their normal, copy-pasted-from-a-tutorial
code runs unmodified. The transformations are:

===========================  =================================================
``while ...:``               ``await _pw_yield()`` inserted as the first
                             statement of the body
``clock.tick(60)``           ``await _pw_tick(clock, 60)``
``time.sleep(x)``            ``await _pw_sleep(x)``
``pygame.time.wait(ms)``     ``await _pw_wait(ms)``
``input(prompt)``            ``await _pw_input(prompt)``
===========================  =================================================

Any function that gains an ``await`` becomes ``async def``, and that property
propagates to its callers transitively ("async contagion").

Two details matter for a teaching tool:

* **The yield goes at the top of the loop body, not the bottom.** A ``continue``
  would jump straight over a yield placed at the end, reintroducing the freeze.
* **Line numbers are preserved.** Injected nodes borrow their neighbour's
  position and nothing is renumbered, so tracebacks point at the line the
  student actually wrote.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field

DEFAULT_FILENAME = "<your program>"

YIELD = "_pw_yield"
TICK = "_pw_tick"
SLEEP = "_pw_sleep"
WAIT = "_pw_wait"
INPUT = "_pw_input"
MAYBE_AWAIT = "_pw_maybe_await"

HELPERS = (YIELD, TICK, SLEEP, WAIT, INPUT, MAYBE_AWAIT)

_TICK_METHODS = {"tick", "tick_busy_loop"}
_PYGAME_WAIT = {"wait", "delay"}


@dataclass
class Warning_:
    line: int
    message: str

    def __str__(self) -> str:
        return f"line {self.line}: {self.message}"


@dataclass
class Result:
    tree: ast.Module
    async_functions: set = field(default_factory=set)
    warnings: list = field(default_factory=list)
    changed: bool = False

    def unparse(self) -> str:
        return ast.unparse(self.tree)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _dotted(node) -> str | None:
    """Return ``a.b.c`` for a nested Attribute/Name chain, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def _own_scope(node):
    """Yield descendants belonging to *node*'s own scope.

    Nested functions and lambdas introduce a new scope, so their contents are
    attributed to them rather than to the enclosing function.
    """
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        yield child
        yield from _own_scope(child)


def _is_generator(fn) -> bool:
    return any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in _own_scope(fn))


def _await_call(name: str, args: list, ref: ast.AST) -> ast.Await:
    """Build ``await name(*args)`` positioned at *ref*."""
    call = ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=list(args), keywords=[])
    node = ast.Await(value=call)
    ast.copy_location(call, ref)
    ast.copy_location(node, ref)
    ast.copy_location(call.func, ref)
    return node


def _yield_stmt(ref: ast.AST) -> ast.Expr:
    stmt = ast.Expr(value=_await_call(YIELD, [], ref))
    return ast.copy_location(stmt, ref)


# ---------------------------------------------------------------------------
# analysis
# ---------------------------------------------------------------------------


class _Analyzer:
    """Work out which functions must become ``async def``.

    Analysis is project-wide rather than per-file. If ``helper.py`` defines
    ``def update()`` containing a loop, that becomes ``async def``, and every
    caller in every other file has to await it. A file analysed in isolation
    could not know that, so all trees are added before propagation runs.

    Import bookkeeping stays per-file, because ``from time import sleep`` in one
    file must not change how a bare ``sleep()`` is treated in another.
    """

    def __init__(self):
        self.functions: dict[str, list] = {}
        self.calls: dict[str, set] = {}
        self.needs: set = set()
        self.generators: set = set()
        self._imports: dict[int, tuple[bool, set]] = {}

    # -- per file ----------------------------------------------------------

    def add_tree(self, tree: ast.Module) -> None:
        self._collect_imports(tree)
        self._collect_functions(tree)
        self._seed(tree)

    def finish(self) -> set:
        self._propagate()
        return self.needs

    def _collect_imports(self, tree: ast.Module) -> None:
        bare_sleep = False
        aliases = {"time.sleep"}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "time":
                for alias in node.names:
                    if alias.name == "sleep":
                        bare_sleep = True
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "time" and alias.asname:
                        aliases.add(f"{alias.asname}.sleep")
        self._imports[id(tree)] = (bare_sleep, aliases)
        self._current = (bare_sleep, aliases)

    def use_tree(self, tree: ast.Module) -> None:
        """Select which file's import context blocking_kind should use."""
        self._current = self._imports.get(id(tree), (False, {"time.sleep"}))

    def _collect_functions(self, tree: ast.Module) -> None:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, []).append(node)
                if _is_generator(node):
                    self.generators.add(node.name)
                callees = {
                    name
                    for child in _own_scope(node)
                    if isinstance(child, ast.Call)
                    for name in (self._callee(child),)
                    if name
                }
                # Same-named functions in different files share an entry; union
                # their callees so propagation stays conservative.
                self.calls.setdefault(node.name, set()).update(callees)

    @staticmethod
    def _callee(call: ast.Call) -> str | None:
        if isinstance(call.func, ast.Name):
            return call.func.id
        if isinstance(call.func, ast.Attribute):
            return call.func.attr
        return None

    def blocking_kind(self, call: ast.Call) -> str | None:
        """Classify a call as one of the constructs that needs awaiting."""
        bare_sleep, aliases = self._current
        func = call.func
        if isinstance(func, ast.Attribute):
            if func.attr in _TICK_METHODS:
                return "tick"
            dotted = _dotted(func)
            if dotted in aliases:
                return "sleep"
            if func.attr in _PYGAME_WAIT and dotted and dotted.endswith("pygame.time." + func.attr):
                return "wait"
            if func.attr in _PYGAME_WAIT and dotted in ("time.wait", "time.delay"):
                return "wait"
        elif isinstance(func, ast.Name):
            if func.id == "input":
                return "input"
            if func.id == "sleep" and bare_sleep:
                return "sleep"
        return None

    def _seed(self, tree: ast.Module) -> None:
        """Mark functions that directly contain something needing an await."""
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for child in _own_scope(node):
                if isinstance(child, ast.While) or (
                    isinstance(child, ast.Call) and self.blocking_kind(child)
                ):
                    self.needs.add(node.name)
                    break

    def _propagate(self) -> None:
        """A caller of an async function must itself be async."""
        changed = True
        while changed:
            changed = False
            for name, callees in self.calls.items():
                if name in self.needs:
                    continue
                if callees & self.needs:
                    self.needs.add(name)
                    changed = True


# ---------------------------------------------------------------------------
# rewriting
# ---------------------------------------------------------------------------


class _Rewriter(ast.NodeTransformer):
    def __init__(self, analyzer: _Analyzer, async_names: set, warnings: list):
        self.analyzer = analyzer
        self.async_names = async_names
        self.warnings = warnings
        # Module level supports top-level await, so it counts as async.
        self.scope: list = [True]
        self.changed = False

    # -- scopes ------------------------------------------------------------

    def _visit_function(self, node):
        make_async = node.name in self.async_names and node.name not in self.analyzer.generators
        if node.name in self.async_names and node.name in self.analyzer.generators:
            self.warnings.append(
                Warning_(
                    node.lineno,
                    f"'{node.name}' is a generator containing a loop, so it cannot be "
                    "made async. If that loop runs for a long time the page will freeze.",
                )
            )

        self.scope.append(make_async or isinstance(node, ast.AsyncFunctionDef))
        self.generic_visit(node)
        self.scope.pop()

        if make_async and isinstance(node, ast.FunctionDef):
            # FunctionDef and AsyncFunctionDef have identical field layouts, so
            # retyping in place preserves every field and source position.
            # setattr avoids a spurious static-typing complaint.
            setattr(node, "__class__", ast.AsyncFunctionDef)
            self.changed = True
        return node

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_Lambda(self, node):
        self.scope.append(False)
        self.generic_visit(node)
        self.scope.pop()
        return node

    # -- loops -------------------------------------------------------------

    def visit_While(self, node):
        self.generic_visit(node)
        if not self.scope[-1]:
            self.warnings.append(
                Warning_(node.lineno, "this loop cannot yield to the browser and may freeze the page.")
            )
            return node
        # Top of the body, so `continue` cannot skip it.
        node.body.insert(0, _yield_stmt(node.body[0] if node.body else node))
        self.changed = True
        return node

    # -- calls -------------------------------------------------------------

    def visit_Call(self, node):
        self.generic_visit(node)
        kind = self.analyzer.blocking_kind(node)
        in_async = self.scope[-1]

        if kind and not in_async:
            self.warnings.append(
                Warning_(node.lineno, f"'{kind}' here cannot yield to the browser and may freeze the page.")
            )
            return node

        if kind == "tick" and isinstance(node.func, ast.Attribute):
            # clock.tick(60) -> await _pw_tick(clock, 60)
            self.changed = True
            return _await_call(TICK, [node.func.value, *node.args], node)
        if kind == "sleep":
            self.changed = True
            return _await_call(SLEEP, node.args, node)
        if kind == "wait":
            self.changed = True
            return _await_call(WAIT, node.args, node)
        if kind == "input":
            self.changed = True
            return _await_call(INPUT, node.args, node)

        if not in_async:
            return node

        # Calls to functions we turned async.
        if isinstance(node.func, ast.Name) and node.func.id in self.async_names:
            if node.func.id in self.analyzer.generators:
                return node
            self.changed = True
            return ast.copy_location(ast.Await(value=node), node)

        # Method calls: we cannot prove the receiver's type, so defer the
        # decision to runtime.
        if isinstance(node.func, ast.Attribute) and node.func.attr in self.async_names:
            if node.func.attr in self.analyzer.generators:
                return node
            self.changed = True
            return _await_call(MAYBE_AWAIT, [node], node)

        return node


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def transform(source: str, filename: str = DEFAULT_FILENAME) -> Result:
    """Rewrite *source* so its loops yield to the browser event loop."""
    return transform_project({filename: source})[filename]


def transform_project(files: dict) -> dict:
    """Transform several files together, sharing one async analysis.

    *files* maps filename to source. Returns a matching map of results. Analysing
    the whole project at once is what lets a call in ``main.py`` be awaited when
    the function it targets only became async because of a loop in another file.
    """
    trees: dict = {}
    for name, source in files.items():
        trees[name] = ast.parse(source, filename=name)

    analyzer = _Analyzer()
    for tree in trees.values():
        analyzer.add_tree(tree)
    async_names = analyzer.finish()

    results: dict = {}
    for name, tree in trees.items():
        analyzer.use_tree(tree)
        warnings: list = []
        rewriter = _Rewriter(analyzer, async_names, warnings)
        rewritten = rewriter.visit(tree)
        ast.fix_missing_locations(rewritten)
        results[name] = Result(
            tree=rewritten,
            async_functions=async_names - analyzer.generators,
            warnings=warnings,
            changed=rewriter.changed,
        )
    return results


def has_top_level_await(tree: ast.Module) -> bool:
    """True if the module body itself awaits, outside any function."""
    return any(isinstance(node, ast.Await) for node in _own_scope(tree))


class CircularImport(Exception):
    """Raised when project modules import each other in a cycle."""


def module_name(filename: str) -> str:
    """'helper.py' -> 'helper'."""
    return filename[:-3] if filename.endswith(".py") else filename


def project_imports(tree: ast.Module, known: set) -> list:
    """Names of *project* modules imported by this tree, in source order."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in known and root not in found:
                    found.append(root)
        elif isinstance(node, ast.ImportFrom):
            # Relative imports have no meaning in a flat project.
            if node.level or not node.module:
                continue
            root = node.module.split(".")[0]
            if root in known and root not in found:
                found.append(root)
    return found


def import_order(trees: dict, entry: str) -> list:
    """Modules reachable from *entry*, dependencies first.

    *trees* maps module name to AST. Only statically reachable modules are
    returned, so an unused file never runs its side effects.
    """
    known = set(trees)
    order: list = []
    done: set = set()
    active: list = []

    def visit(name: str) -> None:
        if name in done:
            return
        if name in active:
            cycle = " -> ".join([*active[active.index(name):], name])
            raise CircularImport(f"circular import: {cycle}")
        active.append(name)
        for dep in project_imports(trees[name], known):
            if dep in trees:
                visit(dep)
        active.pop()
        done.add(name)
        order.append(name)

    visit(entry)
    return order


def compile_module(source: str, filename: str = DEFAULT_FILENAME):
    """Transform and compile *source* into a top-level-await code object."""
    result = transform(source, filename)
    code = compile(
        result.tree,
        filename,
        "exec",
        flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
    )
    return code, result
