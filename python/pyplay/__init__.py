"""Browser runtime support for running ordinary pygame code in the page.

* :mod:`pyplay.transform` rewrites blocking user code into cooperative async code.
* :mod:`pyplay.runtime` provides the helpers that rewritten code calls, plus the
  pygame patches needed under Emscripten.
"""

from . import runtime, transform

__all__ = ["runtime", "session", "transform"]


def __getattr__(name):
    # `session` pulls in asyncio machinery, so load it lazily. Note this must
    # use importlib rather than `from . import session`: the latter routes back
    # through this same __getattr__ and recurses until the stack blows.
    if name == "session":
        import importlib

        return importlib.import_module(".session", __name__)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
