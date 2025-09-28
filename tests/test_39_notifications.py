import lib.config as config
from lib.notifications import NotificationDispatcher, NotificationFilters, build_dispatcher


def test_filters_require_threshold_and_type():
    filters = NotificationFilters.from_cfg(
        {"min_trigger_rms": 500, "allowed_event_types": ["Human"]}
    )

    assert not filters.matches({"trigger_rms": 400, "etype": "Human"})
    assert not filters.matches({"trigger_rms": 600, "etype": "Other"})
    assert filters.matches({"trigger_rms": 600, "etype": "Human"})


def test_build_dispatcher_short_circuits():
    assert build_dispatcher(None) is None
    assert (
        build_dispatcher({"enabled": False, "webhook": {"url": "http://example"}})
        is None
    )
    assert build_dispatcher({"enabled": True}) is None

    dispatcher = build_dispatcher(
        {
            "enabled": True,
            "webhook": {"url": "http://example"},
        }
    )
    assert isinstance(dispatcher, NotificationDispatcher)


def test_dispatcher_matches(monkeypatch):
    class Dummy(NotificationDispatcher):
        def __init__(self):
            super().__init__(
                filters=NotificationFilters.from_cfg(
                    {"min_trigger_rms": 300, "allowed_event_types": ["Both"]}
                ),
                webhook_cfg={"url": ""},
                email_cfg={},
                run_async=False,
            )
            self.webhook_payloads = []
            self.email_payloads = []

        def _send_webhook(self, payload):
            self.webhook_payloads.append(payload)

        def _send_email(self, payload):
            self.email_payloads.append(payload)

    dummy = Dummy()
    dummy.handle_event({"trigger_rms": 200, "etype": "Both"})
    assert not dummy.webhook_payloads
    assert not dummy.email_payloads

    dummy.handle_event({"trigger_rms": 400, "etype": "Both"})
    assert dummy.webhook_payloads and dummy.email_payloads


def test_filters_resolve_custom_event_tags(monkeypatch):
    monkeypatch.setenv("EVENT_TAG_HUMAN", "Speech")
    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    config.reload_cfg()

    filters = NotificationFilters.from_cfg(
        {"allowed_event_types": ["Human"], "min_trigger_rms": None}
    )

    assert filters.matches({"trigger_rms": 0, "etype": "Speech"})
    assert not filters.matches({"trigger_rms": 0, "etype": "Other"})

    monkeypatch.setattr(config, "_cfg_cache", None, raising=False)
    config.reload_cfg()
