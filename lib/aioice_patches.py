"""Compatibility patches for aioice behaviour on older asyncio versions."""

from __future__ import annotations

import importlib
import logging
from functools import wraps
from typing import Any, Optional, Tuple

_LOG = logging.getLogger("webrtc_manager")

_spec = importlib.util.find_spec("aioice.ice")
if _spec is not None:
    aioice_ice = importlib.import_module("aioice.ice")
    StunProtocol = getattr(aioice_ice, "StunProtocol", None)
    if StunProtocol is not None:
        original_send_stun = StunProtocol.send_stun

        if getattr(original_send_stun, "__tricorder_patch__", False):
            safe_send_stun = original_send_stun
        else:

            @wraps(original_send_stun)
            def safe_send_stun(self: Any, message: Any, addr: Tuple[str, int]) -> Optional[object]:
                transport = getattr(self, "transport", None)
                if transport is None:
                    if _LOG.isEnabledFor(logging.DEBUG):
                        _LOG.debug(
                            "Ignoring STUN send on closed transport for %s to %s", self, addr
                        )
                    return None
                return original_send_stun(self, message, addr)

            setattr(safe_send_stun, "__tricorder_patch__", True)

        StunProtocol.send_stun = safe_send_stun

        original_close = getattr(StunProtocol, "close", None)
        if callable(original_close) and not getattr(original_close, "__tricorder_patch__", False):

            @wraps(original_close)
            async def safe_close(self: Any, *args: Any, **kwargs: Any) -> Optional[object]:
                transport = getattr(self, "transport", None)
                should_call_original = True

                if transport is None:
                    should_call_original = False
                else:
                    is_closing = getattr(transport, "is_closing", None)
                    if callable(is_closing):
                        try:
                            if transport.is_closing():
                                should_call_original = False
                        except Exception:
                            pass

                if should_call_original:
                    return await original_close(self, *args, **kwargs)

                closed_future = getattr(self, "_StunProtocol__closed", None)
                if closed_future is not None:
                    if not closed_future.done():
                        try:
                            await closed_future
                        except Exception:
                            if _LOG.isEnabledFor(logging.DEBUG):
                                _LOG.debug(
                                    "Ignoring error awaiting STUN close completion for %s", self,
                                    exc_info=True,
                                )
                    return None

                return await original_close(self, *args, **kwargs)

            setattr(safe_close, "__tricorder_patch__", True)
            StunProtocol.close = safe_close
