import pytest
import httpx
import asyncio

from port_ocean.helpers.retry import RetryTransport


class FlakyTransport(httpx.AsyncBaseTransport):
    """A transport that fails with ReadTimeout twice before succeeding."""

    def __init__(self):
        self.attempts = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:  # type: ignore[override]
        self.attempts += 1
        # Fail for the first two attempts, succeed afterwards
        if self.attempts <= 2:
            raise httpx.ReadTimeout("simulated timeout", request=request)
        return httpx.Response(200, request=request, json={"ok": True})


@pytest.mark.asyncio
async def test_retry_transport_retries_post_on_timeout(monkeypatch):
    """Ensure RetryTransport retries POST requests on transient ReadTimeout errors.

    Current buggy behaviour: RetryTransport treats POST as non-retryable, thus the
    request errors out after the first timeout and never succeeds. Once fixed,
    the transport should retry and eventually succeed.
    """

    flaky = FlakyTransport()
    retry_transport = RetryTransport(wrapped_transport=flaky, max_attempts=5)

    # Eliminate real sleeping to keep the test fast
    monkeypatch.setattr(retry_transport, "_calculate_sleep", lambda *args, **kwargs: 0)

    request = httpx.Request("POST", "https://example.com/data")

    # When the bug is present, this await raises httpx.ReadTimeout after the first failure.
    # Once the bug is fixed, the retries should lead to a successful 200 response.
    response = await retry_transport.handle_async_request(request)

    assert response.status_code == 200
    # Transport should have been attempted three times: two failures + one success
    assert flaky.attempts == 3
