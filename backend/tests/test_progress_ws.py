"""Progress WebSocket fan-out hub (commit: fan-out progress WebSocket).

The old design gave each job a single queue.Queue with one consumer, so two tabs
on the same job stole each other's events and the loop blocked an executor thread
for the job's lifetime. The hub fans each event out to every subscriber's own
asyncio.Queue (bridged thread-safely from the sync worker), so no thread is
pinned and every subscriber sees the full stream.
"""
import asyncio
import threading
import time

import pytest
from starlette.testclient import TestClient

from src import config, db
from src.api import routes
from src.api.routes import _ProgressHub


def test_hub_fans_out_to_all_subscribers():
    """Two subscribers (two tabs) each get the FULL stream — no event stealing."""
    async def scenario():
        loop = asyncio.get_running_loop()
        hub = _ProgressHub()
        q1 = hub.subscribe(loop)
        q2 = hub.subscribe(loop)

        # Publish from a worker thread, exactly as the download worker does.
        def produce():
            hub.put({"type": "progress", "value": 1})
            hub.put({"type": "done"})
        threading.Thread(target=produce).start()

        got1 = [await asyncio.wait_for(q1.get(), 2) for _ in range(2)]
        got2 = [await asyncio.wait_for(q2.get(), 2) for _ in range(2)]
        return got1, got2

    got1, got2 = asyncio.run(scenario())
    assert got1 == got2 == [{"type": "progress", "value": 1}, {"type": "done"}]


def test_hub_drops_events_with_no_subscribers():
    async def scenario():
        loop = asyncio.get_running_loop()
        hub = _ProgressHub()
        hub.put({"type": "progress"})  # no subscribers → dropped, no error
        q = hub.subscribe(loop)
        hub.put({"type": "done"})      # only events after subscribe arrive
        return await asyncio.wait_for(q.get(), 2)

    assert asyncio.run(scenario()) == {"type": "done"}


def test_hub_unsubscribe_stops_delivery():
    async def scenario():
        loop = asyncio.get_running_loop()
        hub = _ProgressHub()
        q = hub.subscribe(loop)
        hub.unsubscribe(q)
        hub.put({"type": "done"})
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), 0.2)

    asyncio.run(scenario())


def test_ws_streams_published_events_end_to_end(monkeypatch):
    """Full handler path: an authenticated subscriber receives events published
    to the job's hub, and a terminal event closes the socket."""
    monkeypatch.setattr(config, "DEV_AUTH_BYPASS", True)  # skip cookie auth for the test
    monkeypatch.setattr(
        db, "get",
        lambda jid: {"id": jid, "owner_id": "dev-user", "status": "downloading"} if jid == "job-x" else None,
    )

    hub = _ProgressHub()
    routes._jobs["job-x"] = {"queue": hub, "file_path": None, "tmp_dir": None}
    try:
        with TestClient(routes.app) as client:
            with client.websocket_connect("/ws/progress/job-x") as ws:
                assert ws.receive_json()["type"] == "snapshot"
                # Wait until the handler has subscribed, then publish.
                for _ in range(200):
                    if hub._subs:
                        break
                    time.sleep(0.01)
                assert hub._subs, "handler never subscribed"
                hub.put({"type": "progress", "value": 42})
                hub.put({"type": "done"})
                assert ws.receive_json() == {"type": "progress", "value": 42}
                assert ws.receive_json() == {"type": "done"}
    finally:
        routes._jobs.pop("job-x", None)
