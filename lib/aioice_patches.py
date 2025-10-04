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
