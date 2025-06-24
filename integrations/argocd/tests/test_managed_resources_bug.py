import pytest
import httpx
from unittest.mock import AsyncMock, patch

from integrations.argocd.client import ArgocdClient


def _make_empty_json_response(url: str) -> httpx.Response:
    """Create a 200 OK httpx.Response whose JSON body is an empty dict."""
    request = httpx.Request("GET", url)
    return httpx.Response(status_code=200, json={}, request=request)


@pytest.fixture()
def argocd_client():
    return ArgocdClient(
        token="dummy-token",
        server_url="https://example.com",
        ignore_server_error=False,
        allow_insecure=True,  # dedicated client we can patch safely
    )


@pytest.mark.asyncio
async def test_get_resources_should_return_empty_list_when_items_missing(argocd_client):
    """Desired behaviour: do *not* raise when 'items' key is absent."""

    async def fake_request(method: str, url: str, **kwargs):  # noqa: D401,WPS110
        return _make_empty_json_response(url)

    with patch.object(argocd_client.http_client, "request", new=AsyncMock(side_effect=fake_request)):
        result = await argocd_client.get_resources("application")

    assert result == []


@pytest.mark.asyncio
async def test_get_managed_resources_already_handles_missing_items(argocd_client):
    """Current correct behaviour for get_managed_resources should stay the same."""

    async def fake_request(method: str, url: str, **kwargs):  # noqa: WPS110
        return _make_empty_json_response(url)

    with patch.object(argocd_client.http_client, "request", new=AsyncMock(side_effect=fake_request)):
        result = await argocd_client.get_managed_resources("some-app")

    assert result == []