import asyncio
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

import httpx

from port_ocean.helpers.retry import RetryTransport

if TYPE_CHECKING:
    from port_ocean.clients.port.client import PortClient


class TokenRetryTransport(RetryTransport):
    def __init__(self, port_client: "PortClient", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.port_client = port_client

    async def _handle_unauthorized(self, response: httpx.Response) -> None:
        token = await self.port_client.auth.token
        response.headers["Authorization"] = f"Bearer {token}"

    def is_token_error(self, response: httpx.Response) -> bool:
        return (
            response.status_code == HTTPStatus.UNAUTHORIZED
            and "/auth/access_token" not in str(response.request.url)
            and self.port_client.auth.last_token_object is not None
            and self.port_client.auth.last_token_object.expired
        )

    async def _should_retry_async(self, response: httpx.Response) -> bool:
        if self.is_token_error(response):
            if self._logger:
                self._logger.info(
                    "Got unauthorized response, trying to refresh token before retrying"
                )
            await self._handle_unauthorized(response)
            return True
        return await super()._should_retry_async(response)

    def _should_retry(self, response: httpx.Response) -> bool:
        """Decide synchronously whether to retry the request.

        If the response signals an expired or invalid token we first refresh it.
        Without a running event loop we call ``asyncio.run`` directly; otherwise
        the coroutine runs in a helper thread so the current loop keeps running.
        """
        if self.is_token_error(response):
            if self._logger:
                self._logger.info(
                    "Got unauthorized response, refreshing token before retry"
                )
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                # No active loop.
                asyncio.run(self._handle_unauthorized(response))
            else:
                # Inside an event loop – refresh in a separate thread.
                import threading

                exception_holder: list[Exception] = []

                def _runner() -> None:
                    try:
                        asyncio.run(self._handle_unauthorized(response))
                    except Exception as exc:  # pragma: no cover
                        exception_holder.append(exc)

                thread = threading.Thread(target=_runner, name="token-refresh-thread")
                thread.start()
                thread.join()
                if exception_holder:
                    raise exception_holder[0]

            return True
        return super()._should_retry(response)
