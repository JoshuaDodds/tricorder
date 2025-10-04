import asyncio

from lib import aioice_patches  # noqa: F401


class _DummyReceiver:
    def __init__(self) -> None:
        self.closed = False

    def data_received(self, *_args):
        self.closed = True


class _DummyTransport:
    def __init__(self, *, closing: bool) -> None:
        self._closing = closing
        self.closed = False

    def is_closing(self) -> bool:
        return self._closing

    def close(self) -> None:
        self.closed = True


def test_stun_close_skips_when_transport_already_closing():
    from aioice.ice import StunProtocol

    async def runner() -> None:
        receiver = _DummyReceiver()
        protocol = StunProtocol(receiver)  # type: ignore[call-arg]
        transport = _DummyTransport(closing=True)
        protocol.transport = transport  # type: ignore[attr-defined]
        protocol._StunProtocol__closed.set_result(True)  # type: ignore[attr-defined]

        await protocol.close()

        assert not transport.closed

    asyncio.run(runner())


def test_stun_close_closes_when_transport_active():
    from aioice.ice import StunProtocol

    async def runner() -> None:
        receiver = _DummyReceiver()
        protocol = StunProtocol(receiver)  # type: ignore[call-arg]
        transport = _DummyTransport(closing=False)
        protocol.transport = transport  # type: ignore[attr-defined]

        async def mark_closed() -> None:
            await asyncio.sleep(0)
            protocol._StunProtocol__closed.set_result(True)  # type: ignore[attr-defined]

        asyncio.get_running_loop().create_task(mark_closed())

        await protocol.close()

        assert transport.closed

    asyncio.run(runner())
