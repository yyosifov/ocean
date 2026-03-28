import pytest
from unittest.mock import MagicMock

from port_ocean.core.handlers.entity_processor.jq_entity_processor import JQEntityProcessor

@pytest.mark.asyncio
async def test_in_filter_supported():
    """The JQ processor should support the IN builtin. When the expression
    is valid, the processor ought to evaluate the selector without throwing
    and return the correct boolean value. Currently this fails, exposing the
    bug described in the issue.
    """
    processor = JQEntityProcessor(context=MagicMock())
    data = {"prop": "value1"}
    pattern = '.prop | IN("value1", "value2")'

    result = await processor._search_as_bool(data, pattern)
    assert result is True
