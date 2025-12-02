import pickle
import stat as _stat
from pathlib import Path
from typing import Any, Optional

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
        self._cache_dir.mkdir(parents=True, exist_ok=True)

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
            # Validate directory permission bits (write + exec) before writing.
            mode = self._cache_dir.stat().st_mode
            write_bits = _stat.S_IWUSR | _stat.S_IWGRP | _stat.S_IWOTH
            exec_bits = _stat.S_IXUSR | _stat.S_IXGRP | _stat.S_IXOTH
            has_write = bool(mode & write_bits)
            has_exec = bool(mode & exec_bits)
            if not (has_write and has_exec):
                raise FailedToWriteCacheFileError(
                    f"Cache directory is not writable/executable: {self._cache_dir}"
                )
            with open(cache_path, "wb") as f:
                pickle.dump(value, f)
        except (pickle.PickleError, IOError) as e:
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
