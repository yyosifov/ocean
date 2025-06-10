import asyncio
from unittest.mock import patch, MagicMock

# Import the relevant functions/classes from the codebase
from port_ocean.core.defaults.clean import clean_defaults

# Dummy classes to simulate config_class and integration_config
class DummyConfigClass:
    pass

class DummyIntegrationConfig:
    resources_path = 'dummy_path'

# Simulate the defaults returned: no blueprints, but integration/config exists
class DummyDefaults:
    blueprints = []

# Simulate the port client with integration/config present
class DummyPortClient:
    def __init__(self):
        self.integration_deleted = False
        self.config_deleted = False
    async def delete_blueprint(self, *args, **kwargs):
        raise Exception('Should not be called, no blueprints')
    async def delete_integration(self, *args, **kwargs):
        self.integration_deleted = True
    async def delete_configuration(self, *args, **kwargs):
        self.config_deleted = True

# Async mock helpers
def async_return(result):
    async def _coroutine(*args, **kwargs):
        return result
    return _coroutine

def main():
    # Patch ocean, get_port_integration_defaults, and is_integration_exists
    with patch('port_ocean.core.defaults.clean.ocean') as mock_ocean, \
         patch('port_ocean.core.defaults.clean.get_port_integration_defaults') as mock_get_defaults, \
         patch('port_ocean.core.defaults.clean.is_integration_exists') as mock_is_integration_exists:
        # Setup mocks
        mock_port_client = DummyPortClient()
        mock_ocean.port_client = mock_port_client
        mock_get_defaults.return_value = DummyDefaults()
        mock_is_integration_exists.side_effect = async_return(True)

        try:
            clean_defaults(DummyConfigClass, DummyIntegrationConfig(), force=True, wait=True)
        except Exception as e:
            print(f'Error during clean_defaults: {e}')
            print('Issue Reproduced')
            return

        # Check if integration/config was deleted
        if not mock_port_client.integration_deleted and not mock_port_client.config_deleted:
            print('Issue Reproduced')
        else:
            print('Issue Resolved')

if __name__ == '__main__':
    main()
