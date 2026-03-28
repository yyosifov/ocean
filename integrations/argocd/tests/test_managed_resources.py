import pytest
from unittest.mock import AsyncMock

from integrations.argocd.client import ArgocdClient


@pytest.mark.asyncio
async def test_get_managed_resources_items_none_returns_empty_list(monkeypatch):
    """If the ArgoCD API returns an explicit `items: null`, the client should
    gracefully convert it to an empty list so that callers can iterate safely.
    Regression for crash when `items` is None (or omitted).
    """

    client = ArgocdClient(
        token="dummy-token",
        server_url="http://argo.local",
        ignore_server_error=False,
        allow_insecure=True,
    )

    monkeypatch.setattr(
        client,
        "_send_api_request",
        AsyncMock(return_value={"items": None}),
    )

    result = await client.get_managed_resources("test-app")

    assert result == [], "Expected empty list when 'items' value is None"


@pytest.mark.asyncio
async def test_get_managed_resources_items_missing_returns_empty_list(monkeypatch):
    """An ArgoCD response without an `items` key should not raise a KeyError.
    The client is expected to return an empty list in such case (original bug).
    """

    client = ArgocdClient(
        token="dummy-token",
        server_url="http://argo.local",
        ignore_server_error=False,
        allow_insecure=True,
    )

    monkeypatch.setattr(
        client,
        "_send_api_request",
        AsyncMock(return_value={}),
    )

    result = await client.get_managed_resources("test-app")

    assert result == [], "Expected empty list when 'items' key is missing from response"