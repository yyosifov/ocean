import httpx
import time
import pytest

from port_ocean.helpers.retry import RetryTransport


def _disable_sleep(monkeypatch):
    """Patch time.sleep to avoid real waiting during retry backoff."""
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)


@pytest.mark.parametrize("method", ["POST", "GET"])
def test_retry_on_timeout_then_success(monkeypatch, method):
    """Ensure retry occurs once after a ReadTimeout and succeeds for POST and GET."""
    _disable_sleep(monkeypatch)

    attempts = []

    def handler(request: httpx.Request):
        attempts.append(request)
        if len(attempts) == 1:
            raise httpx.ReadTimeout("boom", request=request)
        return httpx.Response(200, request=request)

    transport = RetryTransport(httpx.MockTransport(handler))

    req = httpx.Request(method, "https://example.com/", json={"payload": 1})
    resp = transport.handle_request(req)

    assert resp.status_code == 200
    assert len(attempts) == 2  # initial attempt + one retry


def test_max_attempts_exhausted(monkeypatch):
    """Verify handling when max_attempts is reached without success."""
    _disable_sleep(monkeypatch)

    attempts = []

    def handler(request: httpx.Request):
        attempts.append(request)
        raise httpx.ReadTimeout("still failing", request=request)

    max_attempts = 3
    transport = RetryTransport(httpx.MockTransport(handler), max_attempts=max_attempts)

    req = httpx.Request("POST", "https://example.com/", json={"fail": True})

    with pytest.raises(httpx.ReadTimeout):
        transport.handle_request(req)

    assert len(attempts) == max_attempts + 1  # initial + retries


def test_non_retryable_method_not_retried(monkeypatch):
    """PATCH should not be retried because it's not in RETRYABLE_METHODS."""
    _disable_sleep(monkeypatch)

    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        raise httpx.ReadTimeout("no retry", request=request)

    transport = RetryTransport(httpx.MockTransport(handler))

    req = httpx.Request("PATCH", "https://example.com/resource", json={"x": 1})

    with pytest.raises(httpx.ReadTimeout):
        transport.handle_request(req)

    assert len(calls) == 1


def test_request_body_preserved_across_retries(monkeypatch):
    """Ensure request body stays unchanged on each retry."""
    _disable_sleep(monkeypatch)

    bodies = []

    def handler(request: httpx.Request):
        bodies.append(request.content)
        if len(bodies) < 3:
            raise httpx.ReadTimeout("intermittent", request=request)
        return httpx.Response(200, request=request)

    transport = RetryTransport(httpx.MockTransport(handler))

    payload = {"hello": "world"}
    req = httpx.Request("POST", "https://example.com/echo", json=payload)
    resp = transport.handle_request(req)

    assert resp.status_code == 200
    assert len(bodies) == 3  # two failures then success
    assert len(set(bodies)) == 1  # all bodies identical
    assert bodies[0] == req.content
