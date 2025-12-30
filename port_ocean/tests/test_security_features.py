import os
import stat
import pytest
from pathlib import Path

from port_ocean.cache.disk import DiskCacheProvider
from port_ocean.ocean import Ocean
from port_ocean.clients.auth.oauth_client import OAuthClient
import httpx


@pytest.mark.asyncio
async def test_disk_cache_creates_secure_permissions(tmp_path: Path) -> None:
    cache_dir = tmp_path / ".ocean_cache_test"
    provider = DiskCacheProvider(cache_dir=str(cache_dir))

    # Directory should be created
    assert cache_dir.exists() and cache_dir.is_dir()
    mode = stat.S_IMODE(os.lstat(cache_dir).st_mode)
    # Expect no group/other permissions
    assert mode == 0o700

    # When writing a file, it should be created with restrictive perms
    await provider.set("key", {"a": 1})
    cache_file = cache_dir / "key.pkl"
    assert cache_file.exists()
    fmode = stat.S_IMODE(os.lstat(cache_file).st_mode)
    assert fmode == 0o600


class _TestOAuthClient(OAuthClient):
    def refresh_request_auth_creds(self, request: httpx.Request) -> httpx.Request:  # type: ignore[override]
        return request


def test_oauth_is_enabled_only_if_token_file_exists(tmp_path: Path) -> None:
    # Initialize a single Ocean app context if not already initialized
    # Provide minimal valid configuration
    try:
        _ = Ocean(
            config_override={
                "port": {
                    "client_id": "id",
                    "client_secret": "secret",
                    "base_url": "https://api.getport.io",
                },
                "integration": {"identifier": "id", "type": "type"},
            }
        )
    except Exception:
        # If already initialized in another test, that's fine
        pass

    token_path = tmp_path / "token.txt"

    client = _TestOAuthClient()

    # When path is set but file doesn't exist, OAuth should not be considered enabled
    from port_ocean.context.ocean import ocean

    ocean.app.config.oauth_access_token_file_path = str(token_path)
    assert client.is_oauth_enabled() is False

    # Create the token file and expect OAuth to be enabled
    token_path.write_text("token", encoding="utf-8")
    assert client.is_oauth_enabled() is True
