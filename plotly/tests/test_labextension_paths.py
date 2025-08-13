import importlib
import types

import pytest


@pytest.mark.parametrize("required_key", ["src", "dest", "packageManager", "packageName"])
def test_labextension_paths_contains_required_keys(required_key):
    """The labextension metadata dict returned by Plotly should include
    all keys expected by JupyterLab 4.4+.

    In particular, `packageManager` and `packageName` are required to
    avoid `KeyError` when JupyterLab lists lab extensions.  This test
    will fail until those keys are added, reproducing the reported bug.
    """
    # Lazy import to ensure we exercise the public API exactly as used by JupyterLab
    import plotly

    paths = plotly._jupyter_labextension_paths()

    # Basic sanity: function should return a non-empty list.
    assert isinstance(paths, list) and paths, "Expected a non-empty list from _jupyter_labextension_paths()"

    first_item = paths[0]
    assert isinstance(first_item, dict), "Each item in the list should be a dict with metadata keys"

    # The crux: ensure the metadata dict contains the required key
    assert required_key in first_item, (
        f"Missing '{required_key}' in labextension metadata returned by _jupyter_labextension_paths(); "
        "this will cause JupyterLab to raise KeyError when listing extensions."
    )

    # Optional: verify value is a non-empty string
    value = first_item[required_key]
    assert isinstance(value, str) and value, f"Metadata key '{required_key}' must map to a non-empty string, got: {value!r}"
