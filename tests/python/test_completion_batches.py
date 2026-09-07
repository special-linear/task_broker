import json
import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[2] / "python"))
from task_pool import (ConflictError, PendingCompletions, Task, TaskClient,
                       TaskError, UncertainOperation)


class CompletionBatchTests(unittest.TestCase):
    def client(self, **kwargs):
        return TaskClient("experiments", "http://127.0.0.1:8787", "test-key",
                          worker_id=kwargs.pop("worker_id", "stable"), **kwargs)

    def tasks(self, client, count):
        return [Task(client, {"task_id": f"task-{i}", "attempt_id": str(uuid.uuid4()),
                              "lease_token": "lease-secret", "lease_generation": 1,
                              "instance_epoch": "test-epoch", "data": {"n": i}})
                for i in range(count)]

    def response(self, operation):
        return {"items": [{"item_id": item["item_id"], "task_id": item["task_id"],
                           "attempt_id": item["attempt_id"], "status": "applied"}
                          for item in json.loads(operation.body)["items"]]}

    def test_one_request_with_lease_identity_runtime_and_lossless_results(self):
        client = self.client()
        tasks = self.tasks(client, 3)
        for task in tasks:
            task.received_at = 100
        tasks[1].runtime_origin = "recovered"
        sent = []

        def transport(endpoint, body, timeout):
            self.assertEqual(endpoint, "report")
            sent.append(json.loads(body))
            response = self.response(client.pending_completions.operations[0])
            return 200, {}, json.dumps({"ok": True, "data": response}).encode()

        with patch.object(client, "_transport", side_effect=transport), patch("task_pool.time.monotonic", return_value=110):
            results = client.complete_many([(tasks[0], {"large": 9007199254740993}),
                                            (tasks[1], {"text": "α"}), (tasks[2], None, 0)])
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["pool"], client.pool)
        self.assertEqual(sent[0]["worker_id"], client.worker_id)
        items = sent[0]["items"]
        for task, item in zip(tasks, items):
            for key, value in task._identity().items():
                self.assertEqual(item[key], value)
            self.assertEqual(item["outcome"], "success")
        self.assertEqual(items[0]["result"], {"large": "9007199254740993"})
        self.assertEqual(items[1]["result"], {"text": "α"})
        self.assertIsNone(items[2]["result"])
        self.assertEqual([item["runtime_seconds"] for item in items], [10, 10, 0])
        self.assertEqual([item["runtime_origin"] for item in items], ["received", "recovered", "explicit"])
        self.assertEqual([item["task_id"] for item in results], [task.task_id for task in tasks])
        self.assertIsNone(client.pending_completions)

    def test_chunking_preserves_order_and_returns_all_partial_rejections(self):
        client = self.client()
        tasks = self.tasks(client, 45)
        sent = []

        def send(operation):
            sent.append(json.loads(operation.body))
            response = self.response(operation)
            for item in response["items"]:
                if item["task_id"] in ("task-1", "task-42"):
                    item.update(status="rejected", error={"code": "INVALID_RESULT", "message": "Expected text"})
                elif item["task_id"] == "task-2":
                    item["status"] = "already_applied"
            return response

        with patch.object(client, "retry", side_effect=send):
            results = client.complete_many((task, task.data) for task in tasks)
        self.assertEqual([len(body["items"]) for body in sent], [20, 20, 5])
        self.assertEqual(len({body["request_id"] for body in sent}), 3)
        self.assertEqual(len({item["item_id"] for body in sent for item in body["items"]}), 45)
        self.assertEqual([item["task_id"] for item in results], [task.task_id for task in tasks])
        self.assertEqual([i for i, item in enumerate(results) if item["status"] == "rejected"], [1, 42])
        self.assertEqual(results[2]["status"], "already_applied")
        with patch.object(client, "retry", side_effect=self.response) as send:
            corrected = client.complete_many([(tasks[1], "corrected")])
        self.assertEqual(corrected[0]["status"], "applied")
        self.assertNotEqual(json.loads(send.call_args.args[0].body)["request_id"], sent[0]["request_id"])

    def test_empty_and_invalid_input_never_send_a_partial_submission(self):
        client = self.client()
        tasks = self.tasks(client, 21)
        foreign = self.tasks(self.client(), 1)[0]
        duplicate = Task(client, tasks[0].to_handle())
        invalid = [[(foreign, 1)], [(tasks[0], 1), (duplicate, 2)], [(tasks[0],)],
                   [(tasks[0], 1, float("nan"))], [(tasks[0], 1, -1)],
                   [(task, 1) for task in tasks[:20]] + [(tasks[20], object())],
                   [(task, 1) for task in tasks[:20]] + [(tasks[20], "x" * (512 * 1024))]]
        with patch.object(client, "_transport") as transport:
            self.assertEqual(client.complete_many([]), [])
            for entries in invalid:
                with self.subTest(entries=len(entries)), self.assertRaises((ValueError, TypeError)):
                    client.complete_many(entries)
                self.assertIsNone(client.pending_completions)
            transport.assert_not_called()

    def test_request_byte_limit_is_checked_independently_of_item_count(self):
        client = self.client()
        tasks = self.tasks(client, 2)
        # These oversized result values may be rejected per item by the server,
        # but the client must still respect the whole-request byte bound.
        with patch.object(client, "retry", side_effect=self.response) as send:
            client.complete_many([(task, "α" * 150000) for task in tasks])
        self.assertEqual(send.call_count, 2)
        for call in send.call_args_list:
            self.assertLessEqual(len(call.args[0].body), 512 * 1024)

    def interrupted(self):
        client = self.client()
        tasks = self.tasks(client, 45)
        entries = [(task, task.data, 0.5) for task in tasks]
        sent = []

        def send(operation):
            sent.append(operation.body)
            if len(sent) == 2:
                raise UncertainOperation(operation, "Lost second batch response")
            response = self.response(operation)
            response["items"][0].update(status="rejected", error={"code": "INVALID_RESULT", "message": "Expected text"})
            return response

        with patch.object(client, "retry", side_effect=send), self.assertRaises(UncertainOperation):
            client.complete_many(entries)
        self.assertEqual(client.pending_completions.next_batch, 1)
        self.assertEqual(len(client.pending_completions.results), 20)
        return client, tasks, entries, sent

    def test_unchanged_retry_skips_acknowledged_batches_and_reuses_exact_body(self):
        client, tasks, entries, sent = self.interrupted()
        with patch.object(client, "retry", return_value={"items": [{"status": "applied", "expires_at": "2099-01-01T00:00:00Z"}]}):
            tasks[20].renew()
        self.assertEqual(tasks[20].expires_at, "2099-01-01T00:00:00Z")
        self.assertEqual(client.pending_completions.next_batch, 1)
        with patch.object(client, "retry", side_effect=self.response) as send:
            with self.assertRaises(ConflictError):
                client.complete_many(entries[:-1])
            for mutate in [lambda: tasks[20].complete(1), lambda: tasks[20].release(),
                           lambda: tasks[20].fail("unsupported")]:
                with self.assertRaises(ConflictError):
                    mutate()
            send.assert_not_called()
            results = client.complete_many(entries)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(send.call_args_list[0].args[0].body, sent[1])
        self.assertEqual(len(results), 45)
        self.assertEqual(results[0]["status"], "rejected")
        self.assertIsNone(client.pending_completions)

    def test_default_runtime_and_mutable_results_are_frozen_during_retry(self):
        client = self.client()
        task = self.tasks(client, 1)[0]
        result = {"n": 1}
        task.received_at = 100

        def lose(operation):
            raise UncertainOperation(operation, "lost")

        with patch.object(client, "retry", side_effect=lose):
            with patch("task_pool.time.monotonic", return_value=110), self.assertRaises(UncertainOperation):
                client.complete_many([(task, result)])
        original = client.pending_completions.operations[0].body
        result["n"] = 2
        with self.assertRaises(ConflictError):
            client.complete_many([(task, result)])
        with patch.object(client, "retry", side_effect=self.response) as send, patch("task_pool.time.monotonic", return_value=999):
            client.complete_many([(task, {"n": 1})])
        self.assertEqual(send.call_args.args[0].body, original)
        self.assertEqual(json.loads(original)["items"][0]["runtime_seconds"], 10)

    def test_restart_restores_all_unsent_batches_and_prior_outcomes(self):
        original, tasks, entries, sent = self.interrupted()
        serialized = json.dumps(original.pending_completions.to_dict())
        self.assertNotIn(original.key, serialized)
        restored = PendingCompletions.from_dict(json.loads(serialized))
        wrong_worker = self.client(worker_id="different")
        with patch.object(wrong_worker, "retry") as send, self.assertRaises(ValueError):
            wrong_worker.retry_completions(restored)
        send.assert_not_called()
        self.assertIsNone(wrong_worker.pending_completions)
        client = self.client()
        with patch.object(client, "retry", side_effect=self.response) as send:
            results = client.retry_completions(restored)
        self.assertEqual([len(json.loads(call.args[0].body)["items"]) for call in send.call_args_list], [20, 5])
        self.assertEqual(send.call_args_list[0].args[0].body, sent[1])
        self.assertEqual([item["task_id"] for item in results], [task.task_id for task in tasks])
        self.assertEqual(results[0]["status"], "rejected")
        self.assertIsNone(client.pending_completions)

    def test_incomplete_response_retains_batch_for_replay(self):
        client = self.client()
        tasks = self.tasks(client, 2)
        for response in (None, {"items": []}, {"items": [{"item_id": "wrong", "status": "applied"}] * 2}):
            with patch.object(client, "retry", return_value=response), self.assertRaises(UncertainOperation):
                client.complete_many([(task, 1) for task in tasks])
            self.assertEqual(client.pending_completions.next_batch, 0)
            self.assertEqual(client.pending_completions.results, [])
        with patch.object(client, "retry", side_effect=self.response):
            self.assertEqual(len(client.retry_completions()), 2)

    def test_request_error_keeps_progress_and_stops_future_batches(self):
        client = self.client()
        tasks = self.tasks(client, 21)
        count = 0

        def transport(endpoint, body, timeout):
            nonlocal count
            count += 1
            return 503, {}, json.dumps({"ok": False, "error": {"code": "QUOTA_EXCEEDED", "message": "quota", "retryable": False}}).encode()

        with patch.object(client, "_transport", side_effect=transport), self.assertRaises(TaskError) as raised:
            client.complete_many([(task, 1) for task in tasks])
        self.assertEqual(raised.exception.code, "QUOTA_EXCEEDED")
        self.assertEqual(count, 1)
        self.assertEqual(client.pending_completions.next_batch, 0)
        with patch.object(client, "retry", side_effect=self.response):
            self.assertEqual(len(client.retry_completions()), 21)

    def test_pending_individual_operation_and_nonzero_rank_are_respected(self):
        client = self.client()
        task = self.tasks(client, 1)[0]
        task.pending = client.prepare("report", {"items": []})
        with patch.object(client, "retry") as send:
            with self.assertRaises(UncertainOperation) as raised:
                client.complete_many([(task, 1)])
            self.assertIs(raised.exception.operation, task.pending)
            task.pending = None
            with patch.dict(os.environ, {"RANK": "1"}):
                with self.assertRaises(TaskError):
                    client.complete_many([(task, 1)])
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
