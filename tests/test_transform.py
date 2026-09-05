"""Tests for the blocking -> async source transformer.

The important tests here are the ones that *execute* the transformed code
rather than merely inspecting its shape: they prove the loop actually hands
control back to the event loop, which is the entire point of the exercise.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import textwrap

import pytest

from pyplay import runtime
from pyplay.transform import compile_module, transform


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def src(text: str) -> str:
    return textwrap.dedent(text).strip() + "\n"


def out(text: str) -> str:
    """Transform and unparse, for structural assertions."""
    return transform(src(text)).unparse()


def run(text: str, extra: dict | None = None) -> dict:
    """Transform, compile and actually execute, returning the globals."""
    code, _result = compile_module(src(text))
    g: dict = {name: getattr(runtime, name) for name in
               ("_pw_yield", "_pw_tick", "_pw_sleep", "_pw_wait", "_pw_input", "_pw_maybe_await")}
    g["__name__"] = "__main__"
    if extra:
        g.update(extra)

    runtime.reset()

    async def main():
        result = eval(code, g)  # noqa: S307 - compiling our own AST
        if inspect.isawaitable(result):
            await result

    asyncio.run(main())
    return g


# ---------------------------------------------------------------------------
# loop yielding
# ---------------------------------------------------------------------------


def test_functiondef_and_asyncfunctiondef_stay_layout_compatible():
    """The transformer retypes a FunctionDef node in place via __class__.

    That preserves every field and source position, but only works while the
    two node types declare identical fields. Python has kept them in step so
    far (3.12 added type_params to both). Fail loudly here rather than
    mysteriously if a future version diverges.
    """
    assert ast.FunctionDef._fields == ast.AsyncFunctionDef._fields, (
        "ast node layouts diverged; transform.py must build a new node instead "
        "of reassigning __class__"
    )


def test_while_loop_gets_a_yield():
    assert "await _pw_yield()" in out("""
        while True:
            x = 1
    """)


def test_yield_is_first_statement_so_continue_cannot_skip_it():
    tree = transform(src("""
        while running:
            if skip:
                continue
            work()
    """)).tree
    loop = tree.body[0]
    assert isinstance(loop, ast.While)
    first = loop.body[0]
    assert isinstance(first, ast.Expr) and isinstance(first.value, ast.Await), (
        "yield must be the first statement, otherwise `continue` jumps over it"
    )


def test_nested_while_loops_both_yield():
    assert out("""
        while a:
            while b:
                pass
    """).count("await _pw_yield()") == 2


def test_for_loops_are_left_alone():
    # Bounded in practice for beginner code; injecting here would slow down
    # every tight numeric loop for no benefit.
    assert "_pw_yield" not in out("""
        for i in range(10):
            print(i)
    """)


def test_code_without_loops_is_untouched():
    result = transform(src("x = 1 + 2\nprint(x)\n"))
    assert result.changed is False


# ---------------------------------------------------------------------------
# blocking call rewrites
# ---------------------------------------------------------------------------


def test_clock_tick_becomes_awaited_helper():
    assert "await _pw_tick(clock, 60)" in out("""
        while True:
            clock.tick(60)
    """)


def test_tick_busy_loop_is_also_rewritten():
    assert "await _pw_tick(clock, 30)" in out("""
        while True:
            clock.tick_busy_loop(30)
    """)


def test_time_sleep_becomes_awaited():
    assert "await _pw_sleep(0.5)" in out("""
        import time
        while True:
            time.sleep(0.5)
    """)


def test_bare_sleep_import_is_rewritten():
    assert "await _pw_sleep(1)" in out("""
        from time import sleep
        while True:
            sleep(1)
    """)


def test_bare_sleep_without_the_import_is_not_touched():
    # A user-defined sleep() must not be hijacked.
    assert "_pw_sleep" not in out("""
        def sleep(n):
            return n
        while True:
            sleep(1)
    """)


def test_pygame_time_wait_is_rewritten():
    assert "await _pw_wait(100)" in out("""
        import pygame
        while True:
            pygame.time.wait(100)
    """)


def test_input_becomes_awaited():
    assert "await _pw_input('name? ')" in out("x = input('name? ')")


# ---------------------------------------------------------------------------
# async contagion
# ---------------------------------------------------------------------------


def test_function_containing_a_loop_becomes_async():
    result = out("""
        def game():
            while True:
                pass
        game()
    """)
    assert "async def game():" in result
    assert "await game()" in result


def test_contagion_is_transitive():
    result = out("""
        def inner():
            while True:
                pass
        def middle():
            inner()
        def outer():
            middle()
        outer()
    """)
    assert result.count("async def") == 3
    assert "await inner()" in result
    assert "await middle()" in result
    assert "await outer()" in result


def test_method_calls_are_awaited_defensively():
    result = out("""
        class Game:
            def loop(self):
                while True:
                    pass
            def start(self):
                self.loop()
    """)
    assert "async def loop(self):" in result
    # We cannot prove the receiver's type statically, so defer to runtime.
    assert "_pw_maybe_await(self.loop())" in result


def test_plain_function_stays_sync():
    result = out("""
        def add(a, b):
            return a + b
        add(1, 2)
    """)
    assert "async def" not in result
    assert "await" not in result


def test_recursive_function_with_loop_terminates_analysis():
    result = out("""
        def f(n):
            while n > 0:
                n -= 1
            if n:
                f(n)
        f(3)
    """)
    assert "async def f(n):" in result


# ---------------------------------------------------------------------------
# generators - the case we deliberately refuse to convert
# ---------------------------------------------------------------------------


def test_generator_with_loop_is_not_converted_and_warns():
    result = transform(src("""
        def counter():
            i = 0
            while True:
                yield i
                i += 1
    """))
    text = result.unparse()
    assert "async def counter" not in text, "converting would make it an async generator"
    assert any("generator" in w.message for w in result.warnings)


# ---------------------------------------------------------------------------
# line numbers and tracebacks
# ---------------------------------------------------------------------------


def test_original_line_numbers_are_preserved():
    text = src("""
        x = 1
        while True:
            y = 2
            break
        z = 3
    """)
    tree = transform(text).tree
    assign_x, loop, assign_z = tree.body[0], tree.body[1], tree.body[2]
    assert assign_x.lineno == 1
    assert loop.lineno == 2
    assert assign_z.lineno == 5, "statements after an injected yield must not shift"


def test_traceback_points_at_the_users_line():
    text = src("""
        import time
        while True:
            time.sleep(0)
            raise ValueError('boom')
    """)
    code, _ = compile_module(text, filename="<user>")
    g = {name: getattr(runtime, name) for name in
         ("_pw_yield", "_pw_tick", "_pw_sleep", "_pw_wait", "_pw_input", "_pw_maybe_await")}
    runtime.reset()

    async def main():
        await eval(code, g)  # noqa: S307

    with pytest.raises(ValueError) as exc:
        asyncio.run(main())

    tb = exc.tb
    while tb.tb_next:
        tb = tb.tb_next
    assert tb.tb_frame.f_code.co_filename == "<user>"
    assert tb.tb_lineno == 4, "raise is on line 4 of the original source"


# ---------------------------------------------------------------------------
# execution semantics - the tests that actually matter
# ---------------------------------------------------------------------------


def test_transformed_loop_really_yields_to_the_event_loop():
    """A blocking loop must become cooperative: a competing task must progress."""
    ticks = {"n": 0}

    async def competitor():
        for _ in range(5):
            await asyncio.sleep(0)
            ticks["n"] += 1

    code, _ = compile_module(src("""
        count = 0
        while count < 200:
            count += 1
    """))
    g = {name: getattr(runtime, name) for name in
         ("_pw_yield", "_pw_tick", "_pw_sleep", "_pw_wait", "_pw_input", "_pw_maybe_await")}
    runtime.reset()

    async def main():
        other = asyncio.ensure_future(competitor())
        await eval(code, g)  # noqa: S307
        await other

    asyncio.run(main())
    assert g["count"] == 200
    assert ticks["n"] == 5, "the other task must have run while the loop was going"


def test_loop_with_break_and_continue_executes_correctly():
    g = run("""
        total = 0
        i = 0
        while True:
            i += 1
            if i > 10:
                break
            if i % 2:
                continue
            total += i
    """)
    assert g["total"] == 2 + 4 + 6 + 8 + 10
    assert g["i"] == 11


def test_while_else_still_runs_its_else_branch():
    g = run("""
        n = 0
        while n < 3:
            n += 1
        else:
            done = True
    """)
    assert g["done"] is True
    assert g["n"] == 3


def test_globals_stay_global_so_the_global_statement_works():
    """Wrapping user code in a function would break this; top-level await does not."""
    g = run("""
        score = 0
        def bump():
            global score
            score += 1
        bump()
        bump()
    """)
    assert g["score"] == 2


def test_async_contagion_executes_end_to_end():
    g = run("""
        log = []
        def worker(n):
            i = 0
            while i < n:
                i += 1
            log.append(n)
            return n * 2
        def driver():
            return worker(3) + worker(4)
        result = driver()
    """)
    assert g["result"] == 14
    assert g["log"] == [3, 4]


def test_method_contagion_executes_end_to_end():
    g = run("""
        class Counter:
            def __init__(self):
                self.value = 0
            def count_to(self, n):
                while self.value < n:
                    self.value += 1
                return self.value
            def run(self):
                return self.count_to(5)
        c = Counter()
        result = c.run()
    """)
    assert g["result"] == 5


def test_maybe_await_passes_through_non_coroutines():
    """A same-named sync method must not break when another class's is async."""
    g = run("""
        class Slow:
            def step(self):
                while False:
                    pass
                return 'slow'
        class Fast:
            def step(self):
                return 'fast'
        a = Slow().step()
        b = Fast().step()
    """)
    assert g["a"] == "slow"
    assert g["b"] == "fast"


def test_sleep_actually_suspends():
    g = run("""
        import time
        marks = []
        t0 = time.monotonic()
        time.sleep(0.05)
        marks.append(time.monotonic() - t0)
    """)
    assert g["marks"][0] >= 0.04


def test_input_is_awaited_and_uses_the_hook():
    runtime.state["input_hook"] = lambda prompt: f"<{prompt}>"
    try:
        g = run("answer = input('name')")
        assert g["answer"] == "<name>"
    finally:
        runtime.state["input_hook"] = None


# ---------------------------------------------------------------------------
# realistic beginner programs
# ---------------------------------------------------------------------------


TUTORIAL_GAME = """
import pygame

pygame.init()
screen = pygame.display.set_mode((640, 480))
clock = pygame.time.Clock()
font = pygame.font.Font(None, 36)

x, y = 320, 240
running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
    keys = pygame.key.get_pressed()
    if keys[pygame.K_LEFT]:
        x -= 5
    if keys[pygame.K_RIGHT]:
        x += 5
    screen.fill((30, 30, 60))
    pygame.draw.circle(screen, (255, 200, 0), (x, y), 20)
    screen.blit(font.render('Score: 0', True, (255, 255, 255)), (10, 10))
    pygame.display.flip()
    clock.tick(60)
pygame.quit()
"""


def test_canonical_tutorial_game_transforms_correctly():
    result = transform(TUTORIAL_GAME)
    text = result.unparse()
    assert "await _pw_yield()" in text
    assert "await _pw_tick(clock, 60)" in text
    assert result.warnings == []
    # Must still compile as a top-level-await module.
    compile_module(TUTORIAL_GAME)


def test_class_based_game_transforms_without_warnings():
    program = """
import pygame

class Game:
    def __init__(self):
        pygame.init()
        self.screen = pygame.display.set_mode((320, 240))
        self.clock = pygame.time.Clock()
        self.running = True

    def handle_events(self):
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False

    def draw(self):
        self.screen.fill((0, 0, 0))
        pygame.display.flip()

    def run(self):
        while self.running:
            self.handle_events()
            self.draw()
            self.clock.tick(60)

Game().run()
"""
    result = transform(program)
    text = result.unparse()
    assert "async def run(self):" in text
    assert "await _pw_tick(self.clock, 60)" in text
    assert result.warnings == []
    compile_module(program)
