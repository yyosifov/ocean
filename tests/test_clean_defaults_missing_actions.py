import asyncio
import types

import pytest

from port_ocean.core.defaults import clean as clean_mod


class _DummyDefaults:
    """Minimal stand-in that contains both blueprints *and* actions."""

    def __init__(self):
        self.blueprints = [{"identifier": "dummy_bp"}]
        self.actions = [{"identifier": "dummy_action"}]
        self.scorecards = []
        self.pages = []
        self.port_app_config = None


class _MockPortClient:
    """Captures which delete helpers are invoked by _clean_defaults."""

    def __init__(self):
        self.deleted_blueprints = []
        self.deleted_actions = []  # collect deleted action identifiers

    async def delete_action(self, identifier, *, should_raise=True, delete_entities=False):
        """Mock counterpart of port_client.delete_action"""
        self.deleted_actions.append(identifier)
        return None  # no migration id generated

    # APIs that _clean_defaults currently calls -----------------------------
    async def delete_blueprint(self, identifier, *, should_raise=True, delete_entities=False):
        self.deleted_blueprints.append(identifier)
        return None  # no migration id generated

    async def delete_current_integration(self):
        return {"ok": True}

    async def wait_for_migration_to_complete(self, _):
        return None

    async def get_current_integration(self, should_log: bool = False):
        return {"identifier": "dummy"}

    # Note: There is deliberately NO delete_action method – the production
    # code never attempts to call it, which is exactly what we are exposing.


@pytest.mark.asyncio
async def test_clean_defaults_should_delete_actions(monkeypatch):
    """_clean_defaults forgets to delete actions – this test highlights the gap.

    Expected behaviour: when defaults contain actions, the integration clean
    routine should remove them, just like it does blueprints.  Current
    implementation only deletes blueprints, so "deleted_actions" remains empty
    and the assertion at the end fails, reproducing the reported issue.
    """

    # ------------------------------------------------------------------ setup
    mock_pc = _MockPortClient()

    # Replace the global context accessed via `ocean` LocalProxy with a dummy
    # object that exposes the mocked port client.  This bypasses the regular
    # (heavy) initialization path and avoids PortOceanContextNotFoundError.
    import port_ocean.context.ocean as ocean_mod

    ocean_mod._port_ocean = types.SimpleNamespace(port_client=mock_pc)

    # Integration existence check should pass straight away.
    monkeypatch.setattr("port_ocean.core.defaults.common.is_integration_exists", lambda _: True)

    # Provide our crafted defaults object that includes actions.
    monkeypatch.setattr(clean_mod, "get_port_integration_defaults", lambda *_, **__: _DummyDefaults())

    # Minimal stub – its attributes are never used thanks to the previous patch.
    class _IntegrationCfg:
        resources_path = None

    # ----------------------------------------------------------- exercise code
    await clean_mod._clean_defaults(
        config_class=types.SimpleNamespace,  # unused placeholder
        integration_config=_IntegrationCfg(),
        force=False,
        wait=False,
        destroy=False,
    )

    # ----------------------------------------------------------- verify result
    assert mock_pc.deleted_actions, (
        "Actions present in defaults were NOT deleted – expected deletion call "
        "was never made. This assertion purposefully fails to reproduce the "
        "bug described in PORT-12432."
    )
