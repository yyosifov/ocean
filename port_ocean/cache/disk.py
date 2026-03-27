import pickle
from pathlib import Path
from typing import Any, Optional
import os
import stat

from port_ocean.cache.base import CacheProvider
from port_ocean.cache.errors import FailedToReadCacheError, FailedToWriteCacheError
from port_ocean.core.models import CachingStorageMode


class FailedToReadCacheFileError(FailedToReadCacheError):
    pass


class FailedToWriteCacheFileError(FailedToWriteCacheError):
    pass


class DiskCacheProvider(CacheProvider):
    STORAGE_TYPE = CachingStorageMode.disk

    def __init__(self, cache_dir: str | None = None) -> None:
        if cache_dir is None:
            cache_dir = "/tmp/ocean/.ocean_cache"
        self._cache_dir = Path(cache_dir)
        # Create cache directory with restrictive permissions
        self._cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(str(self._cache_dir), 0o700)
        except OSError:
            # Best-effort: if chmod fails, continue
            pass

    def _get_cache_path(self, key: str) -> Path:
        return self._cache_dir / f"{key}.pkl"

    async def get(self, key: str) -> Optional[Any]:
        cache_path = self._get_cache_path(key)
        if not cache_path.exists():
            return None

        try:
            with open(cache_path, "rb") as f:
                return pickle.load(f)
        except (pickle.PickleError, EOFError) as e:
            raise FailedToReadCacheFileError(
                f"Failed to read cache file: {cache_path}: {str(e)}"
            )

    async def set(self, key: str, value: Any) -> None:
        cache_path = self._get_cache_path(key)
        try:

            # Verify the cache directory permission bits include write and exec for at least one class
            dir_mode = self._cache_dir.stat().st_mode
            perm_bits = stat.S_IMODE(dir_mode)
            has_write = bool(perm_bits & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
            has_exec = bool(perm_bits & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
            if not (has_write and has_exec):
                raise PermissionError(f"Cache directory is not writable: {self._cache_dir}")

            with open(cache_path, "wb") as f:
                pickle.dump(value, f)

            try:
                os.chmod(str(cache_path), 0o600)
            except OSError:
                # Best-effort: if chmod fails, continue
                pass
        except (pickle.PickleError, OSError, PermissionError) as e:
            raise FailedToWriteCacheFileError(
                f"Failed to write cache file: {cache_path}: {str(e)}"
            )

    async def clear(self) -> None:
        try:
            for cache_file in self._cache_dir.glob("*.pkl"):
                try:
                    cache_file.unlink()
                except OSError:
                    pass
        except OSError:
            pass
