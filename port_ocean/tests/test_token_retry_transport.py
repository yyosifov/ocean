import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase

import httpx

from port_ocean.clients.port.retry_transport import TokenRetryTransport


class DummyAuth:
    """Auth stub providing an awaitable `token` attribute in the exact form production code expects."""

    def __init__(self, token_value: str = "NEW_TOKEN", expired: bool = True):
        future: asyncio.Future[str] = asyncio.Future()
        future.set_result(token_value)
        # In library code they do: `token = await self.port_client.auth.token` (notice *await attr*)
        # therefore the attribute itself must be awaitable (a Future / coroutine), not a callable.
        self.token = future
        self.last_token_object = SimpleNamespace(expired=expired)


class DummyPortClient:
    def __init__(self, auth):
        self.auth = auth


class TestTokenRetryTransport(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.auth = DummyAuth()
        self.client = DummyPortClient(self.auth)
        # TokenRetryTransport inherits from RetryTransport that requires an underlying transport
        self.transport = TokenRetryTransport(self.client, wrapped_transport=httpx.HTTPTransport())

        # Prepare a 401 response coming from a non-auth endpoint (meets is_token_error conditions)
        request = httpx.Request("GET", "https://api.example.com/data")
        self.response = httpx.Response(401, request=request)

    async def test_should_retry_async_refreshes_token(self):
        """Async variant refreshes token, patches header and returns True."""
        should_retry = await self.transport._should_retry_async(self.response)  # pylint: disable=protected-access
        self.assertTrue(should_retry)
        self.assertEqual(self.response.headers.get("Authorization"), "Bearer NEW_TOKEN")

    async def test_should_retry_sync_does_not_raise_with_running_loop(self):
        """BUG REPRO: Sync _should_retry is called while loop running.
        Current implementation incorrectly calls `run_until_complete` on the *same* loop, which
        raises RuntimeError("This event loop is already running").  The correct behaviour (after
        bug fix) should *not* raise and should still return True.
        The test therefore asserts that no RuntimeError is raised and that it returns True.
        """
        try:
            result = self.transport._should_retry(self.response)  # pylint: disable=protected-access
        except RuntimeError as exc:  # pragma: no cover
            # Fail the test because RuntimeError indicates the bug is still present.
            self.fail(f"_should_retry raised RuntimeError when called inside running loop: {exc}")

        # When no exception, ensure behaviour is correct.
        self.assertTrue(result)
        self.assertEqual(self.response.headers.get("Authorization"), "Bearer NEW_TOKEN")
