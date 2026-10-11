"""Run with the Hermes venv: ~/.hermes/hermes-agent/venv/bin/python -m pytest tests/ -q"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.expanduser(os.getenv("HERMES_AGENT_DIR", "~/.hermes/hermes-agent")))
pytest.importorskip("gateway.platforms.base")

_spec = importlib.util.spec_from_file_location(
    "tammi_adapter", Path(__file__).resolve().parent.parent / "hermes-plugin" / "adapter.py"
)
adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(adapter)

OWN = "a1b2c3d4e5f60718293a4b5c"


@pytest.mark.parametrize("raw,expected", [
    ("group:abc", ("abc", "group")),
    ("g:abc", ("abc", "group")),
    ("peer:u1", ("u1", "peer")),
    ("user:u1", ("u1", "peer")),
    ("u1", ("u1", None)),
    ("#Xk29PqLmZ", ("#Xk29PqLmZ", None)),
    ("@RBT#OA_1", ("@RBT#OA_1", None)),
])
def test_parse_target(raw, expected):
    assert adapter.parse_target(raw) == expected


def test_official_accounts():
    assert adapter.is_official_account("@RBT#OA_260911154574")
    assert adapter.is_official_account("Tammi")
    assert not adapter.is_official_account("f1a2b3c4d5e6f7a8b9c0d1e2")


def test_addressed_by_real_mention_strips_name():
    msg = {"text": "@NGUYỄN VĂN AN tóm tắt giúp", "mentions": [OWN]}
    assert adapter.addressed_text(msg, OWN, "NGUYỄN VĂN AN") == "tóm tắt giúp"


def test_addressed_by_reply_to_own_message():
    msg = {"text": "đúng rồi", "replyTo": {"senderId": OWN}}
    assert adapter.addressed_text(msg, OWN, "Cường") == "đúng rồi"


def test_addressed_by_leading_name_with_word_boundary():
    assert adapter.addressed_text({"text": "hermes: dịch câu này"}, OWN, None) == "dịch câu này"
    assert adapter.addressed_text({"text": "bot ơi"}, OWN, None) == "ơi"
    assert adapter.addressed_text({"text": "botanic garden"}, OWN, None) is None


def test_not_addressed():
    assert adapter.addressed_text({"text": "chuyện phiếm", "mentions": ["someone"]}, OWN, "Cường") is None
    assert adapter.addressed_text({"text": "x", "isMentionAll": True}, OWN, "Cường") is None


def test_local_url():
    assert adapter._is_local_url("http://127.0.0.1:8788")
    assert adapter._is_local_url("http://localhost:8788")
    assert not adapter._is_local_url("http://10.0.0.5:8788")


def _bare_adapter(health, service=False, monkeypatch=None):
    a = adapter.TammiAdapter.__new__(adapter.TammiAdapter)
    a.autostart = True
    a.bridge_url = "http://127.0.0.1:8788"
    a._bridge_proc = None
    a.spawned = 0

    async def _health():
        return health

    def _spawn():
        a.spawned += 1
        return None

    a._health = _health
    a._spawn_bridge = _spawn
    monkeypatch.setattr(adapter, "_service_installed", lambda: service)
    return a


@pytest.mark.parametrize("health,service,expected", [
    (None, False, 1),             # bridge crashed (started by anyone) -> respawn
    ({"ok": True}, False, 0),     # someone else's bridge is up -> leave it
    (None, True, 0),              # OS service owns it -> let launchd/systemd restart it
])
def test_respawn_bridge_if_dead(monkeypatch, health, service, expected):
    import asyncio
    a = _bare_adapter(health, service, monkeypatch)
    asyncio.run(a._respawn_bridge_if_dead())
    assert a.spawned == expected
