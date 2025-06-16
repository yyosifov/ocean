import pytest
import httpx

from port_ocean.helpers.retry import RetryTransport

class MockTransport(httpx.AsyncBaseTransport):
    """A mock transport that responds with predefined side effects."""

    def __init__(self, side_effects):
        self._side_effects = list(side_effects)
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        effect = self._side_effects[self.calls]
        self.calls += 1
        if isinstance(effect, Exception):
            raise effect
        return effect

    # These methods are required by the abstract base class but are not used in the test.
    def close(self):
        pass

    async def aclose(self):
        pass


@pytest.mark.asyncio
async def test_retry_transport_retries_on_post_timeout():
    """Ensure RetryTransport retries POST requests on transient ReadTimeout errors.

    Current buggy behaviour: POST is not considered retryable, so the first ReadTimeout
    propagates and the request is never retried.
    Expected (fixed) behaviour: RetryTransport should retry and eventually return a
    successful response when attempts remain.
    """

    # First attempt raises a ReadTimeout, second attempt succeeds with 200 OK.
    side_effects = [httpx.ReadTimeout("boom"), httpx.Response(status_code=200)]
    inner_transport = MockTransport(side_effects)

    # Configure RetryTransport with only two attempts to keep the test quick.
    retry_transport = RetryTransport(inner_transport, max_attempts=2)

    request = httpx.Request("POST", "https://example.com")

    # When the bug is present, this will raise httpx.ReadTimeout and fail the test.
    # After the bug is fixed, it should succeed and return the 200 response.
    response = await retry_transport.handle_async_request(request)

    assert response.status_code == 200, "RetryTransport should return successful response after retrying."
    assert inner_transport.calls == 2, "POST request should be retried once after a transient timeout."