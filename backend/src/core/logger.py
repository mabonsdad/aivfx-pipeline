from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

try:
    from aws_lambda_powertools import Logger as PowertoolsLogger  # type: ignore
except Exception:  # pragma: no cover - runtime fallback when dependency is missing
    PowertoolsLogger = None


class Logger:
    """Compatibility logger that falls back to stdlib logging when powertools is unavailable."""

    def __init__(self, *args: Any, **kwargs: Any):
        if PowertoolsLogger is not None:
            self._impl = PowertoolsLogger(*args, **kwargs)
            self._fallback = False
            return
        logging.basicConfig(level=logging.INFO)
        self._impl = logging.getLogger("aivfx")
        self._context: dict[str, Any] = {}
        self._fallback = True

    def append_keys(self, **kwargs: Any) -> None:
        if self._fallback:
            self._context.update(kwargs)
            return
        self._impl.append_keys(**kwargs)

    def inject_lambda_context(self, **kwargs: Any) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        if self._fallback:
            def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
                return fn

            return decorator
        return self._impl.inject_lambda_context(**kwargs)

    def info(self, message: str, **kwargs: Any) -> None:
        if self._fallback:
            self._impl.info("%s | %s", message, {**self._context, **kwargs.get("extra", {})})
            return
        self._impl.info(message, **kwargs)

    def warning(self, message: str, **kwargs: Any) -> None:
        if self._fallback:
            self._impl.warning("%s | %s", message, {**self._context, **kwargs.get("extra", {})})
            return
        self._impl.warning(message, **kwargs)

    def exception(self, message: str, **kwargs: Any) -> None:
        if self._fallback:
            self._impl.exception("%s | %s", message, {**self._context, **kwargs.get("extra", {})})
            return
        self._impl.exception(message, **kwargs)

