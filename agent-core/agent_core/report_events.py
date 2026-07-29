"""In-process pub/sub used to push report-store changes to SSE clients.

Deliberately not a message broker: this project runs a single process
(one FastAPI app, one event loop), so a small asyncio-native fan-out — one
queue per connected client, written to by whichever coroutine changed the
store — is enough. This keeps SSE support free of new dependencies or
infrastructure, and keeps the publishing side (the worker loop, the PATCH
handler) decoupled from how many clients happen to be listening, or
whether any are listening at all.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ReportEvent:
    """One SSE message: `event` names what happened (e.g.
    "report_created", "report_updated"), `data` is the JSON-serializable
    payload (a `ReportRecord.to_dict()`).
    """

    event: str
    data: dict[str, Any]

    def to_sse(self) -> str:
        """Renders as a Server-Sent Events frame (note the blank line
        terminator SSE requires between messages).
        """
        return f"event: {self.event}\ndata: {json.dumps(self.data)}\n\n"


class ReportEventBroadcaster:
    """Fans out report events to every currently-subscribed client.

    Each subscriber gets its own bounded queue so one slow or stuck
    consumer can't block delivery to the others, and can't grow without
    bound. A full queue drops the oldest pending event for that one
    subscriber rather than blocking the publisher — an investigation
    finishing (or a status flip) must never wait on an SSE client's
    network being slow.
    """

    def __init__(self, *, max_queue_size: int = 32) -> None:
        self._subscribers: set[asyncio.Queue[ReportEvent]] = set()
        self._max_queue_size = max_queue_size

    def subscribe(self) -> asyncio.Queue[ReportEvent]:
        queue: asyncio.Queue[ReportEvent] = asyncio.Queue(maxsize=self._max_queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[ReportEvent]) -> None:
        self._subscribers.discard(queue)

    async def publish(self, event: str, data: dict[str, Any]) -> None:
        message = ReportEvent(event=event, data=data)
        for queue in list(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(message)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
