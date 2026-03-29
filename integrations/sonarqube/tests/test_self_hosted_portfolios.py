import pytest
import pytest_asyncio
from unittest.mock import AsyncMock

from integrations.sonarqube.client import SonarQubeClient

class _DummyAsyncClient:
    def __init__(self):
        self.headers = {}

    async def request(self, *args, **kwargs):  # pragma: no cover
        return {}

@pytest_asyncio.fixture
async def self_hosted_client(monkeypatch):
    monkeypatch.setattr("integrations.sonarqube.client.http_async_client", _DummyAsyncClient())

    client = SonarQubeClient(
        base_url="https://self-hosted-sonar.local",
        api_key="dummy_api_key",
        organization_id=None,
        app_host="https://ocean.app",
        is_onpremise=True,
    )

    # Patch request helpers we expect NOT to be called.
    api_mock = AsyncMock(return_value={})
    paginated_mock = AsyncMock(return_value=[])
    monkeypatch.setattr(client, "_send_api_request", api_mock)
    monkeypatch.setattr(client, "_send_paginated_request", paginated_mock)

    return client, api_mock, paginated_mock

@pytest.mark.asyncio
async def test_get_all_portfolios_skips_for_self_hosted(self_hosted_client):
    client, api_mock, paginated_mock = self_hosted_client

    async for _ in client.get_all_portfolios():
        pass

    api_mock.assert_not_called()
    paginated_mock.assert_not_called()
