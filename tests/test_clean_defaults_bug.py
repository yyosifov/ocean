import json
import os
import shutil
import tempfile
from pathlib import Path

from port_ocean.core.defaults.clean import clean_defaults
from port_ocean.context.ocean import ocean
from port_ocean.config.settings import IntegrationConfiguration
from port_ocean.core.handlers.port_app_config.models import PortAppConfig


class _MockPortClient:
    """PortClient stub that records which delete_* APIs were invoked."""

    def __init__(self, recorder):
        self._recorder = recorder

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------
    async def get_current_integration(self, should_log: bool = False):
        # Pretend integration exists so cleaning continues
        return {"identifier": "mock-integration"}

    # ------------------------------------------------------------------
    # Delete operations recorded for assertions
    # ------------------------------------------------------------------
    async def delete_blueprint(self, identifier, *, should_raise=True, delete_entities=False):
        self._recorder["blueprints"].append(identifier)
        return None  # No migration triggered in this stub

    async def delete_action(self, identifier, *, should_raise=True, delete_entities=False):
        # `delete_entities` is accepted for signature compatibility but not used in the stub
        self._recorder["actions"].append(identifier)
        return None

    async def delete_current_integration(self):
        self._recorder["integration_deleted"] = True
        return {"ok": True}

    async def wait_for_migration_to_complete(self, migration_id):
        # Not needed for this test
        return None


def test_clean_defaults_does_not_remove_actions():
    """`clean_defaults` should delete actions defaults as well as blueprints.

    According to bug PORT-12432 the current implementation deletes only
    blueprints. This test reproduces the issue by asserting that the mocked
    PortClient's `delete_action` is never called – the assertion fails and the
    test turns red, effectively capturing the regression.
    """

    # ------------------------------------------------------------------
    # 1. Build a temporary defaults directory containing blueprints *and* actions
    # ------------------------------------------------------------------
    tmp_dir = tempfile.mkdtemp()
    resources_dir = Path(tmp_dir) / ".port" / "resources"
    resources_dir.mkdir(parents=True, exist_ok=True)
    (resources_dir / "blueprints.json").write_text(json.dumps([{"identifier": "bp1"}]))
    (resources_dir / "actions.json").write_text(json.dumps([{"identifier": "act1"}]))

    original_cwd = os.getcwd()
    os.chdir(tmp_dir)

    try:
        # --------------------------------------------------------------
        # 2. Inject mocked Ocean context so `clean_defaults` uses our stub
        # --------------------------------------------------------------
        calls = {"blueprints": [], "actions": [], "integration_deleted": False}
        mock_pc = _MockPortClient(calls)

        class _DummyApp:
            def __init__(self, port_client, config):
                self.port_client = port_client
                self.config = config

        integration_cfg = IntegrationConfiguration(
            port={"client_id": "x", "client_secret": "y"},
            integration={"type": "dummy", "identifier": "id", "config": {}},
        )

        # Patch the global `ocean` context
        ocean._app = _DummyApp(mock_pc, integration_cfg)  # type: ignore[attr-defined]

        # --------------------------------------------------------------
        # 3. Execute function under test (mirrors CLI flags: --force --wait)
        # --------------------------------------------------------------
        clean_defaults(PortAppConfig, integration_cfg, force=True, wait=False, destroy=False)

        # --------------------------------------------------------------
        # 4. EXPECTED BEHAVIOUR: both blueprint and action deletions invoked.
        #    CURRENT BUGGY BEHAVIOUR: only blueprint deletion is invoked.
        # --------------------------------------------------------------
        assert calls["blueprints"] == ["bp1"]  # sanity check
        # Failing assertion that exposes the bug
        assert calls["actions"] == [
            "act1",
        ], "clean_defaults neglected to delete actions defaults"

    finally:
        # Cleanup regardless of test result
        os.chdir(original_cwd)
        shutil.rmtree(tmp_dir)
