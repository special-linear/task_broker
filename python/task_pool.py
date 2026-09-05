"""Dependency-free Cloudflare task broker client (Python 3.10+).

The URL is the broker origin; /api/v1 is appended exactly once. No background
threads, heartbeats, SDKs, or persistent credential files are created.
"""
from __future__ import annotations

import datetime as _dt
import email.utils
import hashlib
import json
import math
import os
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Iterable


class TaskError(Exception):
    def __init__(self, code: str, message: str, status: int = 0,
                 retryable: bool = False, details: Any = None):
        super().__init__(message)
        self.code, self.status = code, status
        self.retryable, self.details = retryable, details


class AuthenticationError(TaskError):
    pass


class ConflictError(TaskError):
    pass


class ValidationError(TaskError):
    pass


class UncertainOperation(TaskError):
    """A mutation may have committed. Reuse operation.request_id when retrying."""
    def __init__(self, operation: "PendingOperation", message: str):
        super().__init__("UNCERTAIN_OPERATION", message, retryable=True)
        self.operation = operation


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 9007199254740991 else str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("NaN and infinities are not valid task JSON")
        if value.is_integer() and abs(value) > 9007199254740991:
            raise ValueError("Large integer parameters must be Python ints or exact decimal strings")
        return value
    if isinstance(value, (list, tuple)):
        return [_safe(v) for v in value]
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise ValueError("JSON object keys must be strings")
        return {k: _safe(v) for k, v in value.items()}
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def _encode(value: Any) -> bytes:
    return json.dumps(_safe(value), ensure_ascii=False, allow_nan=False,
                      separators=(",", ":"), sort_keys=True).encode("utf-8")


def _worker_id(explicit: str | None) -> str:
    if explicit:
        return explicit
    if os.environ.get("TASK_MANAGER_WORKER_ID"):
        return os.environ["TASK_MANAGER_WORKER_ID"]
    if os.environ.get("SLURM_JOB_ID"):
        cluster = os.environ.get("SLURM_CLUSTER_NAME", "cluster")
        if os.environ.get("SLURM_ARRAY_JOB_ID"):
            return f"slurm:{cluster}:array-{os.environ['SLURM_ARRAY_JOB_ID']}:{os.environ.get('SLURM_ARRAY_TASK_ID', '0')}"
        return f"slurm:{cluster}:job-{os.environ['SLURM_JOB_ID']}"
    return f"{socket.gethostname()}:{os.getpid()}"


@dataclass(frozen=True)
class PendingOperation:
    endpoint: str
    body: bytes
    fingerprint: str

    @property
    def request_id(self) -> str:
        return json.loads(self.body)["request_id"]

    @property
    def metadata(self) -> dict[str, Any]:
        body = json.loads(self.body)
        return {"request_id": body["request_id"], "request_created_at": body["request_created_at"],
                "endpoint": self.endpoint, "fingerprint": self.fingerprint}

    def to_dict(self) -> dict[str, Any]:
        """Explicit recovery data. May contain lease tokens; store securely."""
        return {"endpoint": self.endpoint, "body": json.loads(self.body), "fingerprint": self.fingerprint}

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "PendingOperation":
        return cls(value["endpoint"], _encode(value["body"]), value["fingerprint"])


class TaskClient:
    def __init__(self, pool: str, url: str | None = None, key: str | None = None,
                 worker_id: str | None = None, *, timeout: float = 15,
                 retry_budget: float = 60, allow_nonzero_rank: bool = False):
        url = (url if url is not None else os.environ.get("TASK_MANAGER_URL", "")).rstrip("/")
        self.key = key if key is not None else os.environ.get("TASK_MANAGER_KEY", "")
        parts = urllib.parse.urlsplit(url)
        if not parts.hostname or parts.query or parts.fragment or parts.username:
            raise ValueError("TASK_MANAGER_URL must be a broker origin, optionally ending in /api/v1")
        if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ValueError("HTTPS is required except for local development")
        if parts.path not in ("", "/api/v1"):
            raise ValueError("Use the broker origin; do not append /claim or /admin")
        if not self.key:
            raise ValueError("TASK_MANAGER_KEY is required")
        if timeout <= 0 or retry_budget <= 0:
            raise ValueError("Timeout and retry budget must be positive")
        self.base_url = url if parts.path == "/api/v1" else url + "/api/v1"
        self.pool, self.worker_id = pool, _worker_id(worker_id)
        self.timeout, self.retry_budget = timeout, retry_budget
        self.allow_nonzero_rank = allow_nonzero_rank
        self.pending_claim: PendingOperation | None = None
        self.last_claim: dict[str, Any] | None = None

    @classmethod
    def from_env(cls, pool: str, **overrides: Any) -> "TaskClient":
        return cls(pool, **overrides)

    def _rank_guard(self) -> None:
        if not self.allow_nonzero_rank and int(os.environ.get("RANK", "0")) != 0:
            raise TaskError("NONZERO_RANK", "Only torchrun rank zero may mutate task leases by default")

    def prepare(self, endpoint: str, content: dict[str, Any], *,
                request_id: str | None = None, request_created_at: str | None = None) -> PendingOperation:
        self._rank_guard()
        semantic = {"pool": self.pool, "worker_id": self.worker_id, **_safe(content)}
        fingerprint = hashlib.sha256(_encode({"endpoint": endpoint, **semantic})).hexdigest()
        body = {**semantic, "request_id": request_id or str(uuid.uuid4()),
                "request_created_at": request_created_at or _now()}
        return PendingOperation(endpoint, _encode(body), fingerprint)

    def _transport(self, endpoint: str, body: bytes, timeout: float) -> tuple[int, dict[str, str], bytes]:
        request = urllib.request.Request(self.base_url + "/" + endpoint, data=body, method="POST",
                                         headers={"Authorization": "Bearer " + self.key,
                                                  "Content-Type": "application/json", "Accept": "application/json",
                                                  "User-Agent": "TaskBrokerPython/0.1.0"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, dict(response.headers), response.read(2 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read(2048)

    def _request(self, endpoint: str, body: bytes, pending: PendingOperation | None) -> dict[str, Any]:
        deadline = time.monotonic() + self.retry_budget
        delay = 0.5
        last_message = "No response received"
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if pending:
                    raise UncertainOperation(pending, last_message + "; retry with the same operation identity")
                raise TaskError("NETWORK_ERROR", last_message, retryable=True)
            retry_after = 0.0
            try:
                status, headers, raw = self._transport(endpoint, body, min(self.timeout, remaining))
                try:
                    payload = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    payload = None
                if isinstance(payload, dict) and payload.get("ok") is True and 200 <= status < 300:
                    return payload["data"]
                error = payload.get("error", {}) if isinstance(payload, dict) else {}
                code = error.get("code", "HTTP_ERROR")
                snippet = raw[:512].decode("utf-8", "replace").replace(self.key, "[redacted]")
                message = error.get("message", f"HTTP {status}: {snippet}")
                retryable = status in (429, 500, 502, 503, 504) and error.get("retryable", True)
                if code == "QUOTA_EXCEEDED":
                    retryable = False
                if not retryable:
                    cls = AuthenticationError if status in (401, 403) else ConflictError if status in (409, 410) else ValidationError if status in (400, 413, 422) else TaskError
                    raise cls(code, message, status, False, error.get("details"))
                last_message = message
                hint = next((v for k, v in headers.items() if k.lower() == "retry-after"), "")
                try:
                    retry_after = float(hint)
                except ValueError:
                    try:
                        retry_after = max(0, email.utils.parsedate_to_datetime(hint).timestamp() - time.time())
                    except (ValueError, TypeError, AttributeError):
                        pass
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                last_message = f"Transport failure: {type(error).__name__}"
            pause = max(retry_after, delay * random.uniform(0.75, 1.25))
            if pause >= deadline - time.monotonic():
                if pending:
                    raise UncertainOperation(pending, last_message + "; the mutation may have committed")
                raise TaskError("NETWORK_ERROR", last_message, retryable=True)
            time.sleep(pause)
            delay = min(8, delay * 2)

    def retry(self, pending: PendingOperation) -> dict[str, Any]:
        self._rank_guard()
        return self._request(pending.endpoint, pending.body, pending)

    def claim(self, count: int = 1, *, filter: str = "", lease_seconds: int | None = None,
              request_id: str | None = None, request_created_at: str | None = None) -> list["Task"]:
        content: dict[str, Any] = {"count": count, "filter": filter}
        if lease_seconds is not None:
            content["lease_seconds"] = lease_seconds
        prepared = self.prepare("claim", content, request_id=request_id, request_created_at=request_created_at)
        if self.pending_claim and request_id is None:
            if self.pending_claim.fingerprint != prepared.fingerprint:
                raise UncertainOperation(self.pending_claim, "Resolve the earlier uncertain claim before changing claim parameters")
            prepared = self.pending_claim
        self.pending_claim = prepared
        try:
            data = self.retry(prepared)
        except UncertainOperation:
            raise
        except TaskError:
            self.pending_claim = None
            raise
        self.pending_claim = None
        self.last_claim = data
        return [Task(self, handle) for handle in data["tasks"]]

    def recover(self) -> list["Task"]:
        tasks: list[Task] = []
        cursor = None
        while True:
            body = {"pool": self.pool, "worker_id": self.worker_id}
            if cursor:
                body["cursor"] = cursor
            data = self._request("recover", _encode(body), None)
            tasks.extend(Task(self, handle) for handle in data["tasks"])
            cursor = data.get("cursor")
            if not cursor:
                return tasks

    def report(self, items: list[dict[str, Any]], **identity: Any) -> dict[str, Any]:
        return self.retry(self.prepare("report", {"items": items}, **identity))

    def renew(self, items: list[dict[str, Any]], **identity: Any) -> dict[str, Any]:
        return self.retry(self.prepare("renew", {"items": items}, **identity))

    def poll(self, count: int = 1, *, stop: Callable[[], bool] = lambda: False,
             **claim_options: Any) -> Iterable["Task"]:
        delay = 30.0
        while not stop():
            tasks = self.claim(count, **claim_options)
            if tasks:
                delay = 30
                yield from tasks
            else:
                until = time.monotonic() + delay
                while time.monotonic() < until and not stop():
                    time.sleep(min(1, max(0, until - time.monotonic())))
                delay = min(300, delay * 1.5)

    def task_from_handle(self, handle: dict[str, Any]) -> "Task":
        return Task(self, {**handle, "recovered": True})


class Task:
    def __init__(self, client: TaskClient, handle: dict[str, Any]):
        self.client = client
        self._handle = json.loads(_encode(handle))
        restored = self._handle.pop("_client_state", None)
        self.task_id = handle["task_id"]
        self.data, self.tags = handle["data"], handle.get("tags", [])
        self.received_at = time.monotonic()
        self.runtime_origin = "recovered" if handle.get("recovered") else "received"
        self.pending: PendingOperation | None = None
        self._pending_semantic: bytes | None = None
        if restored and restored.get("pending"):
            self.pending = PendingOperation.from_dict(restored["pending"])
            self._pending_semantic = _encode(restored["semantic"])
            request = json.loads(self.pending.body)
            if request["pool"] != client.pool or request["worker_id"] != client.worker_id:
                raise ValueError("Restore a pending task with the same pool and worker identity")

    def __getattr__(self, name: str) -> Any:
        if name in self._handle:
            return self._handle[name]
        raise AttributeError(name)

    def to_handle(self) -> dict[str, Any]:
        """Serializable lease and exact pending request, excluding the family key."""
        handle = json.loads(_encode(self._handle))
        if self.pending is not None:
            handle["_client_state"] = {"pending": self.pending.to_dict(),
                                       "semantic": json.loads(self._pending_semantic)}
        return handle

    def _identity(self) -> dict[str, Any]:
        return {key: self._handle[key] for key in
                ("task_id", "attempt_id", "lease_token", "lease_generation", "instance_epoch")}

    def _mutate(self, endpoint: str, content: dict[str, Any], runtime: float | None = None) -> dict[str, Any]:
        semantic = _encode({"endpoint": endpoint, **content, "runtime_override": runtime})
        if self.pending is None or self._pending_semantic != semantic:
            item = {**self._identity(), "item_id": str(uuid.uuid4()), **content}
            if endpoint == "report":
                measured = time.monotonic() - self.received_at if runtime is None else runtime
                if not math.isfinite(measured) or measured < 0:
                    raise ValueError("Runtime must be finite and nonnegative")
                item.update(runtime_seconds=measured,
                            runtime_origin=self.runtime_origin if runtime is None else "explicit")
            self.pending = self.client.prepare(endpoint, {"items": [item]})
            self._pending_semantic = semantic
        data = self.client.retry(self.pending)
        result = data["items"][0]
        self.pending = None
        self._pending_semantic = None
        if result["status"] == "rejected":
            error = result["error"]
            cls = ConflictError if error["code"] in ("STALE_LEASE", "INPUT_CHANGED", "RESULT_CONFLICT", "LEASE_EXPIRED") else ValidationError
            raise cls(error["code"], error["message"], 409 if cls is ConflictError else 422, details=result)
        if "expires_at" in result:
            self._handle["expires_at"] = result["expires_at"]
        return result

    def complete(self, result: Any, runtime: float | None = None) -> dict[str, Any]:
        return self._mutate("report", {"outcome": "success", "result": _safe(result)}, runtime)

    def release(self, note: str | None = None, details: Any = None) -> dict[str, Any]:
        content: dict[str, Any] = {"outcome": "release"}
        if note is not None:
            content["message"] = note
        if details is not None:
            content["details"] = _safe(details)
        return self._mutate("report", content)

    def fail(self, message: str, details: Any = None) -> dict[str, Any]:
        if not message.strip():
            raise ValueError("Permanent failure requires a nonblank message")
        content = {"outcome": "permanent_failure", "message": message}
        if details is not None:
            content["details"] = _safe(details)
        return self._mutate("report", content)

    def renew(self, lease_seconds: int = 7200) -> dict[str, Any]:
        return self._mutate("renew", {"lease_seconds": lease_seconds})
