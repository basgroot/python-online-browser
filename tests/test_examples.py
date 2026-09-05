"""Every shipped example must survive the transformer cleanly.

These are the programs students see first, so a regression here is highly
visible. They are also the best available corpus of realistic blocking pygame
code, which makes them useful transformer fixtures.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from pyplay.transform import compile_module, import_order, module_name, transform, transform_project

EXAMPLES_DIR = Path(__file__).resolve().parent.parent / "examples"

# Single-file examples live at the top level; multi-file projects get a
# directory containing main.py plus its helpers.
EXAMPLES = sorted(EXAMPLES_DIR.glob("*.py"))
PROJECTS = sorted(d for d in EXAMPLES_DIR.iterdir() if d.is_dir() and (d / "main.py").exists())


def _project_files(directory: Path) -> dict:
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(directory.glob("*.py"))}


def test_examples_directory_is_not_empty():
    assert EXAMPLES, f"no examples found in {EXAMPLES_DIR}"


def test_at_least_one_multi_file_project_ships():
    assert PROJECTS, "the multi-file feature needs a discoverable example"


@pytest.mark.parametrize("directory", PROJECTS, ids=lambda d: d.name)
def test_project_example_transforms_and_orders(directory: Path):
    files = _project_files(directory)
    assert "main.py" in files

    results = transform_project(files)
    for name, result in results.items():
        assert result.warnings == [], f"{directory.name}/{name}: {result.warnings}"

    trees = {module_name(n): results[n].tree for n in files}
    order = import_order(trees, "main")
    assert order[-1] == "main", "the entry point must run last"
    assert len(order) == len(files), "every file in the example should be reachable"


@pytest.mark.parametrize("directory", PROJECTS, ids=lambda d: d.name)
def test_project_example_compiles(directory: Path):
    files = _project_files(directory)
    for name, result in transform_project(files).items():
        compile(result.tree, name, "exec", flags=__import__("ast").PyCF_ALLOW_TOP_LEVEL_AWAIT)


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_is_valid_python(path: Path):
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_transforms_without_warnings(path: Path):
    result = transform(path.read_text(encoding="utf-8"), filename=str(path))
    assert result.warnings == [], f"{path.name}: {[str(w) for w in result.warnings]}"


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_compiles_after_transform(path: Path):
    compile_module(path.read_text(encoding="utf-8"), filename=str(path))


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_game_loops_all_yield(path: Path):
    """Every while-loop in every example must gain a yield, or it would freeze."""
    source = path.read_text(encoding="utf-8")
    result = transform(source, filename=str(path))

    loops = [n for n in ast.walk(result.tree) if isinstance(n, ast.While)]
    if not loops:
        pytest.skip("no while-loops in this example")

    for loop in loops:
        first = loop.body[0]
        assert isinstance(first, ast.Expr) and isinstance(first.value, ast.Await), (
            f"{path.name}: while-loop on line {loop.lineno} does not yield"
        )


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_avoids_apis_broken_in_the_browser(path: Path):
    source = path.read_text(encoding="utf-8")
    assert "pygame.freetype" not in source, "pygame.freetype does not work in Pyodide"
    assert "pygame.mixer" not in source, "audio is not verified in Pyodide"
