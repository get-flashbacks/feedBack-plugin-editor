"""Idle-session TTL sweep (improvement-plan P2, issue #32).

The sweep itself lives at module scope in routes.py
(`_sweep_idle_editor_sessions` / `_dispose_editor_session`), parameterized by
the `sessions` dict so it can be driven in-process without spinning up a real
event loop. These tests exercise the three acceptance criteria from the issue:

1. An idle session (last_touched older than the TTL) is evicted and its
   temporary sandbox directory removed.
2. A recently-touched session is kept.
3. A native sloppak session (whose `dir` is the shared extraction cache) is
   evicted from the dict WITHOUT deleting the shared cache directory.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
import types

import pytest


class _FakeApp:
    def __init__(self):
        self.routes = {}

    def _register(self, path):
        def decorator(fn):
            self.routes[path] = fn
            return fn
        return decorator

    def get(self, path, *args, **kwargs):
        return self._register(path)

    def post(self, path, *args, **kwargs):
        return self._register(path)

    def on_event(self, name, *args, **kwargs):
        # The sweep registers an @app.on_event("startup") hook. This fake
        # app doesn't run a real event loop, so accept the registration
        # without invoking it — the tests call the sweep directly.
        def decorator(fn):
            return fn
        return decorator


@pytest.fixture()
def build_routes(tmp_path):
    added = []
    if "lib" not in sys.modules:
        lib = types.ModuleType("lib")
        lib.__path__ = []
        sys.modules["lib"] = lib
        added.append("lib")
    lib = sys.modules["lib"]
    if "lib.song" not in sys.modules:
        song = types.ModuleType("lib.song")
        song.load_song = lambda *args, **kwargs: None
        song.phrase_to_wire = lambda *args, **kwargs: None
        sys.modules["lib.song"] = song
        lib.song = song
        added.append("lib.song")
    if "lib.sloppak" not in sys.modules:
        sloppak = types.ModuleType("lib.sloppak")
        sys.modules["lib.sloppak"] = sloppak
        lib.sloppak = sloppak
        added.append("lib.sloppak")

    sys.modules.pop("routes", None)
    routes = importlib.import_module("routes")
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    app = _FakeApp()
    routes.setup(app, {
        "config_dir": tmp_path,
        "get_dlc_dir": lambda: dlc,
        "meta_db": None,
        "get_sloppak_cache_dir": lambda: str(tmp_path / "cache"),
    })
    try:
        yield routes
    finally:
        sys.modules.pop("routes", None)
        for name in added:
            sys.modules.pop(name, None)


def _session(tmp_path, *, sid, format="archive", last_touched, sub="sandbox"):
    """Build a session dict whose `dir` is a real, disposable temp subtree."""
    session_dir = tmp_path / sub
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "marker.txt").write_text(sid)
    return {
        "session_id": sid,
        "format": format,
        "dir": str(session_dir),
        "last_touched": last_touched,
    }


def test_idle_session_is_evicted_and_dir_removed(build_routes, tmp_path):
    routes = build_routes
    now = 1_000_000.0
    ttl = routes._SESSION_IDLE_TTL_SECS
    sessions = {
        "idle": _session(tmp_path, sid="idle", last_touched=now - ttl - 10),
    }
    # Sanity: the sandbox exists before the sweep.
    assert (tmp_path / "sandbox" / "marker.txt").is_file()

    evicted = asyncio.run(routes._sweep_idle_editor_sessions(sessions, now=now))

    assert evicted == 1
    assert "idle" not in sessions
    assert not (tmp_path / "sandbox").exists(), "temp sandbox must be removed"


def test_recently_touched_session_is_kept(build_routes, tmp_path):
    routes = build_routes
    now = 1_000_000.0
    ttl = routes._SESSION_IDLE_TTL_SECS
    sessions = {
        "recent": _session(tmp_path, sid="recent", last_touched=now - 10),
    }

    evicted = asyncio.run(routes._sweep_idle_editor_sessions(sessions, now=now))

    assert evicted == 0
    assert "recent" in sessions
    assert (tmp_path / "sandbox" / "marker.txt").is_file()


def test_sloppak_session_evicted_without_deleting_shared_cache(build_routes, tmp_path):
    routes = build_routes
    now = 1_000_000.0
    ttl = routes._SESSION_IDLE_TTL_SECS
    cache_dir = tmp_path / "shared_cache"
    cache_dir.mkdir()
    (cache_dir / "stems").mkdir()
    (cache_dir / "stems" / "kick.wav").write_bytes(b"RIFF")
    sessions = {
        "sloppak": {
            "session_id": "sloppak",
            "format": "sloppak",
            "dir": str(cache_dir),
            "last_touched": now - ttl - 10,
        },
    }

    evicted = asyncio.run(routes._sweep_idle_editor_sessions(sessions, now=now))

    assert evicted == 1
    assert "sloppak" not in sessions
    # The shared extraction cache is exempt from rmtree — the directory and
    # its contents must survive even though the session entry was dropped.
    assert cache_dir.is_dir()
    assert (cache_dir / "stems" / "kick.wav").is_file()


def test_empty_sessions_dict_is_a_noop(build_routes):
    routes = build_routes
    evicted = asyncio.run(routes._sweep_idle_editor_sessions({}, now=1_000_000.0))
    assert evicted == 0


def test_dispose_helper_removes_temp_dir(build_routes, tmp_path):
    routes = build_routes
    sessions = {
        "x": _session(tmp_path, sid="x", last_touched=1.0),
    }
    assert routes._dispose_editor_session(sessions, "x") is True
    assert "x" not in sessions
    assert not (tmp_path / "sandbox").exists()
    # Unknown session id is a clean no-op.
    assert routes._dispose_editor_session(sessions, "missing") is False