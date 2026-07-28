from __future__ import annotations

import asyncio

import pytest

from agent_core.report_events import ReportEventBroadcaster


@pytest.mark.asyncio
async def test_subscriber_receives_published_event():
    broadcaster = ReportEventBroadcaster()
    queue = broadcaster.subscribe()

    await broadcaster.publish("report_created", {"id": "rep-1"})

    event = queue.get_nowait()
    assert event.event == "report_created"
    assert event.data == {"id": "rep-1"}


@pytest.mark.asyncio
async def test_multiple_subscribers_all_receive_the_same_event():
    broadcaster = ReportEventBroadcaster()
    queue_a = broadcaster.subscribe()
    queue_b = broadcaster.subscribe()

    await broadcaster.publish("report_updated", {"id": "rep-1", "status": "resolved"})

    assert queue_a.get_nowait().data == {"id": "rep-1", "status": "resolved"}
    assert queue_b.get_nowait().data == {"id": "rep-1", "status": "resolved"}


@pytest.mark.asyncio
async def test_unsubscribed_queue_receives_nothing():
    broadcaster = ReportEventBroadcaster()
    queue = broadcaster.subscribe()
    broadcaster.unsubscribe(queue)

    await broadcaster.publish("report_created", {"id": "rep-1"})

    assert queue.empty()
    assert broadcaster.subscriber_count == 0


@pytest.mark.asyncio
async def test_full_queue_drops_oldest_event_instead_of_blocking():
    broadcaster = ReportEventBroadcaster(max_queue_size=2)
    queue = broadcaster.subscribe()

    await broadcaster.publish("e", {"n": 1})
    await broadcaster.publish("e", {"n": 2})
    await broadcaster.publish("e", {"n": 3})  # queue was full at {1, 2}; should drop 1

    remaining = [queue.get_nowait().data["n"] for _ in range(2)]
    assert remaining == [2, 3]
    assert queue.empty()


def test_event_renders_as_sse_frame():
    from agent_core.report_events import ReportEvent

    frame = ReportEvent(event="report_created", data={"id": "rep-1"}).to_sse()

    assert frame == 'event: report_created\ndata: {"id": "rep-1"}\n\n'
