from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from port_ocean.context.ocean import PortOceanContext
from port_ocean.core.handlers.entity_processor.jq_entity_processor import (
    JQEntityProcessor,
)


@pytest.fixture
def mocked_processor(monkeypatch: Any) -> JQEntityProcessor:
    # Reuse the mocking pattern from existing tests to avoid full Ocean app setup
    mock_context = AsyncMock()
    monkeypatch.setattr(PortOceanContext, "app", mock_context)
    return JQEntityProcessor(mock_context)


@pytest.mark.asyncio
async def test_handles_backslash_escaped_double_quotes_in_jq_mapping(
    mocked_processor: JQEntityProcessor,
) -> None:
    # Blueprint mapping uses a YAML single-quoted string form that preserves backslashes
    # e.g. '"jiraIssue"' (backslash-escaped double quotes)
    mapping = Mock()
    mapping.port.entity.mappings.dict.return_value = {
        "identifier": ".key",
        "blueprint": '\\"jiraIssue\\"',
        "properties": {},
        "relations": {},
    }
    mapping.port.items_to_parse = None
    mapping.selector.query = "true"

    raw_results = [
        {
            "key": "ISSUE-1",
            "fields": {"summary": "Summary"},
        }
    ]

    result = await mocked_processor._parse_items(mapping, raw_results)

    # Expect one passed entity with the normalized blueprint value
    assert len(result.entity_selector_diff.passed) == 1
    entity = result.entity_selector_diff.passed[0]
    assert entity.identifier == "ISSUE-1"
    assert entity.blueprint == "jiraIssue"


@pytest.mark.asyncio
async def test_handles_single_quoted_empty_string_in_jq_mapping(
    mocked_processor: JQEntityProcessor,
) -> None:
    # Relation uses an invalid jq empty string literal ('') which should be normalized to ""
    mapping = Mock()
    mapping.port.entity.mappings.dict.return_value = {
        "identifier": ".key",
        "blueprint": '"jiraIssue"',
        "relations": {
            "project": "if .fields.project.key then .fields.sprint.name else '' end"
        },
    }
    mapping.port.items_to_parse = None
    mapping.selector.query = "true"

    raw_results = [
        {
            "key": "ISSUE-1",
            "fields": {
                "summary": "Summary",
                "sprint": {"name": "S1", "id": 123},
            },
        }
    ]

    result = await mocked_processor._parse_items(mapping, raw_results)
    assert len(result.entity_selector_diff.passed) == 1
    entity = result.entity_selector_diff.passed[0]
    # Since fields.project is missing, the relation should resolve to an empty string, not None
    assert entity.relations.get("project") == ""
