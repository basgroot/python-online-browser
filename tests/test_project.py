"""Multi-file projects: several .py files where main.py imports the others.

The subtle requirement is cross-file async contagion. A loop inside
``helper.update()`` forces that function to become ``async def``; every call
site in every other file must then await it. A per-file transformer cannot
know that, so these tests pin the project-wide behaviour.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import textwrap

import pytest

from pyplay import runtime, session
from pyplay.transform import (
    CircularImport,
    import_order,
    module_name,
    transform_project,
)


def src(text: str) -> str:
    return textwrap.dedent(text).strip() + "\n"


def run_project(files: dict, entry: str = "main.py") -> dict:
    """Execute a project and return the result dict."""
    return asyncio.run(session.run_project({k: src(v) for k, v in files.items()}, entry))


def unparse(files: dict) -> dict:
    results = transform_project({k: src(v) for k, v in files.items()})
    return {name: result.unparse() for name, result in results.items()}


# ---------------------------------------------------------------------------
# cross-file async contagion
# ---------------------------------------------------------------------------


def test_loop_in_helper_makes_caller_await_across_files():
    out = unparse({
        "helper.py": """
            def update(state):
                while state['n'] < 3:
                    state['n'] += 1
                return state['n']
        """,
        "main.py": """
            import helper
            state = {'n': 0}
            helper.update(state)
        """,
    })
    assert "async def update(state):" in out["helper.py"]
    assert "_pw_maybe_await(helper.update(state))" in out["main.py"], (
        "main.py must await a function that only became async because of helper.py"
    )


def test_from_import_call_is_awaited_across_files():
    out = unparse({
        "helper.py": """
            def spin(n):
                while n > 0:
                    n -= 1
                return 'done'
        """,
        "main.py": """
            from helper import spin
            result = spin(5)
        """,
    })
    assert "async def spin(n):" in out["helper.py"]
    assert "await spin(5)" in out["main.py"]


def test_plain_helper_function_is_not_made_async():
    out = unparse({
        "helper.py": """
            def add(a, b):
                return a + b
        """,
        "main.py": """
            import helper
            total = helper.add(1, 2)
        """,
    })
    assert "async def" not in out["helper.py"]
    assert "await" not in out["main.py"]


# ---------------------------------------------------------------------------
# import ordering
# ---------------------------------------------------------------------------


def _trees(files: dict) -> dict:
    return {module_name(n): ast.parse(src(s)) for n, s in files.items()}


def test_dependencies_are_ordered_before_their_importer():
    order = import_order(
        _trees({
            "main.py": "import b",
            "b.py": "import a",
            "a.py": "x = 1",
        }),
        "main",
    )
    assert order == ["a", "b", "main"]


def test_unreferenced_files_are_not_executed():
    order = import_order(
        _trees({"main.py": "x = 1", "unused.py": "raise RuntimeError('boom')"}),
        "main",
    )
    assert order == ["main"], "an unimported file must not run its side effects"


def test_circular_imports_are_reported_clearly():
    with pytest.raises(CircularImport) as exc:
        import_order(_trees({"main.py": "import a", "a.py": "import main"}), "main")
    assert "circular import" in str(exc.value)


# ---------------------------------------------------------------------------
# execution
# ---------------------------------------------------------------------------


def test_main_can_import_and_use_a_helper():
    result = run_project({
        "helper.py": """
            GREETING = 'hello'

            def shout(word):
                return word.upper() + '!'
        """,
        "main.py": """
            import helper
            message = helper.shout(helper.GREETING)
        """,
    })
    assert result["status"] == "finished", result.get("error")


def test_helper_with_a_loop_executes_correctly_end_to_end():
    captured = []
    runtime.state["input_hook"] = None

    result = run_project({
        "counter.py": """
            def count_to(limit):
                total = 0
                while total < limit:
                    total += 1
                return total
        """,
        "main.py": """
            import counter
            print('counted', counter.count_to(5))
        """,
    })
    assert result["status"] == "finished", result.get("error")
    assert captured == []


def test_class_defined_in_helper_is_usable_from_main():
    result = run_project({
        "sprites.py": """
            class Player:
                def __init__(self):
                    self.x = 0

                def walk(self, steps):
                    while steps > 0:
                        self.x += 1
                        steps -= 1
                    return self.x
        """,
        "main.py": """
            from sprites import Player
            p = Player()
            p.walk(4)
        """,
    })
    assert result["status"] == "finished", result.get("error")


def test_three_level_import_chain_runs():
    result = run_project({
        "a.py": "VALUE = 2",
        "b.py": """
            import a

            def double(n):
                while False:
                    pass
                return n * a.VALUE
        """,
        "main.py": """
            import b
            answer = b.double(21)
        """,
    })
    assert result["status"] == "finished", result.get("error")


# ---------------------------------------------------------------------------
# errors
# ---------------------------------------------------------------------------


def test_error_inside_a_helper_names_that_helper():
    result = run_project({
        "broken.py": """
            def explode():
                raise ValueError('helper blew up')
        """,
        "main.py": """
            import broken
            broken.explode()
        """,
    })
    assert result["status"] == "error"
    assert "helper blew up" in result["error"]
    assert "broken.py" in result["error"], "traceback must name the file at fault"
    assert "main.py" in result["error"], "and the call site"
    assert "pyplay" not in result["error"]


def test_syntax_error_in_a_helper_is_reported():
    result = run_project({
        "bad.py": "def oops(\n",
        "main.py": "import bad",
    })
    assert result["status"] == "error"
    assert "SyntaxError" in result["error"]


def test_missing_entry_point_is_reported():
    result = asyncio.run(session.run_project({"helper.py": "x = 1"}, entry="main.py"))
    assert result["status"] == "error"
    assert "main.py" in result["error"]


def test_circular_import_surfaces_as_an_error_not_a_crash():
    result = run_project({
        "main.py": "import a",
        "a.py": "import main",
    })
    assert result["status"] == "error"
    assert "circular import" in result["error"]


# ---------------------------------------------------------------------------
# isolation between runs
# ---------------------------------------------------------------------------


def test_helper_modules_are_reloaded_on_every_run():
    """Editing a helper must take effect without a page reload."""
    first = run_project({
        "conf.py": "NAME = 'first'",
        "main.py": "import conf\nresult = conf.NAME",
    })
    assert first["status"] == "finished", first.get("error")

    second = run_project({
        "conf.py": "NAME = 'second'",
        "main.py": """
            import conf
            if conf.NAME != 'second':
                raise AssertionError('stale module: ' + conf.NAME)
        """,
    })
    assert second["status"] == "finished", second.get("error")


# ---------------------------------------------------------------------------
# import timing - helpers must run when imported, not before
# ---------------------------------------------------------------------------


def test_helper_runs_at_the_point_of_import_not_before(capsys):
    """Matches CPython ordering.

    Real pygame code depends on this:

        pygame.display.set_mode(...)
        import chesspieces      # loads images, needs the display

    Executing helpers eagerly would run chesspieces before the display exists.
    """
    result = run_project({
        "main.py": """
            print('1: main start')
            import helper
            print('3: main end')
        """,
        "helper.py": "print('2: helper executing')",
    })
    assert result["status"] == "finished", result.get("error")

    printed = [line for line in capsys.readouterr().out.splitlines() if line[:1].isdigit()]
    assert printed == ['1: main start', '2: helper executing', '3: main end']


def test_helper_sees_state_main_set_up_before_importing():
    result = run_project({
        "main.py": """
            import builtins
            builtins.DISPLAY_READY = True
            import needs_display
        """,
        "needs_display.py": """
            import builtins
            if not getattr(builtins, 'DISPLAY_READY', False):
                raise RuntimeError('helper ran too early')
        """,
    })
    assert result["status"] == "finished", result.get("error")


def test_unimported_helper_never_runs():
    result = run_project({
        "main.py": "print('only main')",
        "landmine.py": "raise RuntimeError('should never execute')",
    })
    assert result["status"] == "finished", result.get("error")


def test_top_level_loop_in_helper_warns_but_still_works():
    result = run_project({
        "main.py": "import slowstart\nvalue = slowstart.TOTAL",
        "slowstart.py": """
            TOTAL = 0
            while TOTAL < 3:
                TOTAL += 1
        """,
    })
    assert result["status"] == "finished", result.get("error")
    assert any("runs before" in w for w in result["warnings"]), result["warnings"]


def test_single_file_api_still_works():
    result = asyncio.run(session.run("x = 1 + 1\n"))
    assert result["status"] == "finished", result.get("error")


def test_prepare_project_reports_modules_without_running():
    report = session.prepare_project(
        {"main.py": src("import helper\nhelper.go()"), "helper.py": src("def go():\n    pass")},
    )
    assert report["ok"] is True
    assert report["modules"] == ["helper", "main"]
