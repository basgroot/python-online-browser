"""Runtime support injected alongside transformed user code.

Every helper here is referenced by name from `pyplay.transform`. The names are
deliberately ugly so they cannot collide with anything a student writes.

Design notes driven by Phase 0 measurements:

* A bare ``await asyncio.sleep(0)`` yields the browser event loop but does not
  throttle: a render loop then runs at ~7500 fps and pegs the CPU. So
  :func:`_pw_yield` auto-paces any loop that is actually drawing, detected by
  patching ``pygame.display.flip``/``update``.
* ``clock.tick(60)`` *does* pace correctly in Pyodide, but it blocks the main
  thread while it waits. :func:`_pw_tick` replaces that busy-wait with a real
  ``await`` so the browser stays responsive.
* ``pygame.time.set_timer`` raises ``NotImplementedError`` on WASM, so it is
  reimplemented here on top of asyncio.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import time

__all__ = [
    "_pw_yield",
    "_pw_tick",
    "_pw_sleep",
    "_pw_wait",
    "_pw_maybe_await",
    "_pw_input",
    "install",
    "reset",
    "state",
]

# Frames faster than this are pointless: the browser composites at ~60Hz.
DEFAULT_FPS_CAP = 60.0

state = {
    # Set by the patched display.flip/update so _pw_yield knows the loop draws.
    "drew": False,
    # True once user code calls clock.tick(n); disables auto-pacing so we do
    # not throttle twice and land at half the requested rate.
    "explicit_tick": False,
    "last_frame": 0.0,
    "last_tick": 0.0,
    "fps_cap": DEFAULT_FPS_CAP,
    "input_hook": None,
    "frames": 0,
}


def reset() -> None:
    """Clear per-run state. Called before each execution of user code."""
    state.update(
        drew=False,
        explicit_tick=False,
        last_frame=time.monotonic(),
        last_tick=time.monotonic(),
        fps_cap=DEFAULT_FPS_CAP,
        frames=0,
    )


async def _pw_yield() -> None:
    """Release the browser event loop. Injected at the top of every while-loop.

    Paces automatically when the loop is drawing, unless the program is doing
    its own pacing via clock.tick().
    """
    if state["drew"] and not state["explicit_tick"]:
        state["drew"] = False
        state["frames"] += 1
        target = 1.0 / state["fps_cap"]
        overshoot = target - (time.monotonic() - state["last_frame"])
        await asyncio.sleep(overshoot if overshoot > 0 else 0)
        state["last_frame"] = time.monotonic()
    else:
        await asyncio.sleep(0)


async def _pw_tick(clock, framerate=0):
    """Non-blocking replacement for ``Clock.tick(framerate)``.

    Falls back to the object's own ``tick`` when it is not a pygame Clock, so
    that unrelated ``something.tick()`` calls still behave correctly.
    """
    tick = getattr(clock, "tick", None)
    if tick is None:
        raise AttributeError(
            f"{type(clock).__name__!r} object has no attribute 'tick'"
        )

    # Not a pygame Clock - leave the call alone.
    if type(clock).__name__ not in ("Clock", "ClockType"):
        result = tick(framerate) if framerate else tick()
        return await result if inspect.isawaitable(result) else result

    state["explicit_tick"] = True
    state["frames"] += 1

    if framerate and framerate > 0:
        overshoot = (1.0 / framerate) - (time.monotonic() - state["last_tick"])
        await asyncio.sleep(overshoot if overshoot > 0 else 0)
    else:
        await asyncio.sleep(0)

    state["last_tick"] = time.monotonic()
    # tick(0) does not sleep; it just refreshes the Clock's internal timing so
    # get_fps() and get_time() keep working.
    try:
        return tick(0)
    except Exception:
        return 0


async def _pw_sleep(seconds) -> None:
    """``time.sleep`` blocks the whole tab; this yields instead."""
    await asyncio.sleep(max(0.0, float(seconds)))


async def _pw_wait(millis) -> int:
    """Non-blocking ``pygame.time.wait`` / ``pygame.time.delay``."""
    ms = max(0.0, float(millis))
    started = time.monotonic()
    await asyncio.sleep(ms / 1000.0)
    return int((time.monotonic() - started) * 1000)


async def _pw_maybe_await(value):
    """Await *value* only if it is awaitable.

    Used for attribute calls such as ``self.update()`` where we cannot prove
    statically whether the target became a coroutine function.
    """
    if inspect.isawaitable(value):
        return await value
    return value


async def _pw_input(prompt=""):
    """``input()`` that suspends instead of blocking the browser."""
    hook = state.get("input_hook")
    if hook is None:
        raise RuntimeError(
            "input() needs the interactive console; it is unavailable here."
        )
    result = hook(str(prompt))
    return await result if inspect.isawaitable(result) else result


# --------------------------------------------------------------------------
# pygame patches
# --------------------------------------------------------------------------

_installed = False


def install(pygame_module=None) -> dict:
    """Patch pygame for the browser. Idempotent; safe if pygame is absent."""
    global _installed
    report: dict = {"display_hook": False, "set_timer": False, "freetype": False}

    if pygame_module is None:
        try:
            import pygame as pygame_module  # type: ignore
        except ImportError:
            return report

    if _installed:
        report.update(display_hook=True, set_timer=True, freetype=True)
        return report

    _patch_display(pygame_module, report)
    _patch_set_timer(pygame_module, report)
    _patch_freetype(pygame_module, report)
    _patch_file_objects(pygame_module, report)

    _installed = True
    return report


# Magic numbers, so a file object without a usable name still gets the right
# extension. SDL_image dispatches on the extension when loading from a path.
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"BM", ".bmp"),
    (b"II*\x00", ".tif"),
    (b"MM\x00*", ".tif"),
    (b"\x00\x01\x00\x00", ".ttf"),
    (b"OTTO", ".otf"),
    (b"true", ".ttf"),
    (b"wOFF", ".woff"),
)


def _suffix_for(data: bytes, namehint: str, default: str) -> str:
    if namehint and "." in namehint:
        return "." + namehint.rsplit(".", 1)[-1]
    for magic, suffix in _MAGIC:
        if data.startswith(magic):
            return suffix
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    head = data[:200].lstrip()
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        return ".svg"
    return default


def _spill_to_file(data: bytes, suffix: str) -> str:
    """Write bytes to the virtual filesystem and return the path."""
    import tempfile

    handle, path = tempfile.mkstemp(suffix=suffix, dir="/tmp")
    with os.fdopen(handle, "wb") as fh:
        fh.write(data)
    return path


def _read_all(source) -> bytes | None:
    """Return the bytes of a file-like object, or None if it is not one."""
    read = getattr(source, "read", None)
    if read is None:
        return None
    try:
        source.seek(0)
    except Exception:
        pass
    data = read()
    if isinstance(data, bytearray):
        return bytes(data)
    return data if isinstance(data, bytes) else None


def _patch_file_objects(pygame_module, report) -> None:
    """Let pygame load images and fonts from file-like objects.

    In Pyodide, pygame cannot build an SDL_RWops around a Python object: it
    raises ``RuntimeError: can't access resource on platform``. Only real paths
    work. Since this site has no file uploads, embedding assets as base64 and
    wrapping them in io.BytesIO is the obvious thing for a student to do, so
    spill such objects to a temporary file and load from there instead.
    """
    image = getattr(pygame_module, "image", None)
    if image is not None:
        for fn_name, default_suffix in (("load", ".png"), ("load_extended", ".png")):
            original = getattr(image, fn_name, None)
            if original is None or getattr(original, "_pw_wrapped", False):
                continue
            setattr(image, fn_name, _wrap_loader(original, default_suffix))
        report["image_file_objects"] = True

    font = getattr(pygame_module, "font", None)
    if font is not None:
        original_font = getattr(font, "Font", None)
        if original_font is not None and not getattr(original_font, "_pw_wrapped", False):
            font.Font = _wrap_font(original_font)
            report["font_file_objects"] = True


def _wrap_loader(original, default_suffix):
    def loader(source, namehint=""):
        data = _read_all(source)
        if data is None:
            return original(source, namehint) if namehint else original(source)
        path = _spill_to_file(data, _suffix_for(data, namehint, default_suffix))
        try:
            return original(path)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    setattr(loader, "_pw_wrapped", True)
    loader.__name__ = getattr(original, "__name__", "load")
    loader.__doc__ = getattr(original, "__doc__", None)
    return loader


def _wrap_font(original):
    def Font(source=None, size=20, **kwargs):
        data = _read_all(source)
        if data is None:
            return original(source, size, **kwargs)
        path = _spill_to_file(data, _suffix_for(data, "", ".ttf"))
        try:
            return original(path, size, **kwargs)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    setattr(Font, "_pw_wrapped", True)
    Font.__name__ = "Font"
    return Font


def _patch_display(pygame_module, report) -> None:
    """Record that a frame was drawn so _pw_yield can pace the loop."""
    display = getattr(pygame_module, "display", None)
    if display is None:
        return

    def wrap(fn):
        def wrapped(*args, **kwargs):
            state["drew"] = True
            return fn(*args, **kwargs)

        wrapped.__name__ = getattr(fn, "__name__", "wrapped")
        wrapped.__doc__ = getattr(fn, "__doc__", None)
        return wrapped

    for name in ("flip", "update"):
        fn = getattr(display, name, None)
        if fn is not None and not getattr(fn, "_pw_wrapped", False):
            new = wrap(fn)
            new._pw_wrapped = True  # type: ignore[attr-defined]
            setattr(display, name, new)
    report["display_hook"] = True


def _patch_set_timer(pygame_module, report) -> None:
    """Reimplement set_timer, which raises NotImplementedError on WASM."""
    time_mod = getattr(pygame_module, "time", None)
    event_mod = getattr(pygame_module, "event", None)
    if time_mod is None or event_mod is None:
        return

    timers: dict = {}

    def set_timer(event, millis, loops=0):
        # pygame accepts an int event type or an Event instance.
        event_type = getattr(event, "type", event)

        existing = timers.pop(event_type, None)
        if existing is not None:
            existing.cancel()

        if not millis:
            return

        async def pump():
            fired = 0
            try:
                while True:
                    await asyncio.sleep(millis / 1000.0)
                    try:
                        if hasattr(event, "type"):
                            event_mod.post(event)
                        else:
                            event_mod.post(event_mod.Event(event_type))
                    except Exception:
                        return
                    fired += 1
                    if loops and fired >= loops:
                        return
            except asyncio.CancelledError:
                return

        try:
            timers[event_type] = asyncio.ensure_future(pump())
        except RuntimeError:
            # No running loop (e.g. called at import time) - ignore.
            pass

    def cancel_all():
        for task in timers.values():
            task.cancel()
        timers.clear()

    time_mod.set_timer = set_timer
    state["cancel_timers"] = cancel_all
    report["set_timer"] = True


def _patch_freetype(pygame_module, report) -> None:
    """pygame.freetype is broken in Pyodide; fail with a useful message."""
    try:
        import pygame.freetype as ft  # type: ignore
    except Exception:
        return

    message = (
        "pygame.freetype is not available in the browser. "
        "Use pygame.font instead, for example: pygame.font.Font(None, 32)"
    )

    def broken_init(*_args, **_kwargs):
        raise NotImplementedError(message)

    class BrokenFont:
        def __init__(self, *_args, **_kwargs):
            raise NotImplementedError(message)

    ft.init = broken_init
    ft.Font = BrokenFont
    ft.SysFont = broken_init
    report["freetype"] = True
