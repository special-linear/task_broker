import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parents[2] / "python"))
from task_pool import TaskClient, Task, TaskError, UncertainOperation, PendingOperation, _safe

class ClientTests(unittest.TestCase):
    def client(self):
        return TaskClient("experiments", "http://127.0.0.1:8787", "test-key", worker_id="stable")

    def test_url_and_large_integer(self):
        self.assertTrue(self.client().base_url.endswith('/api/v1'))
        client = TaskClient("experiments", "https://example.com/api/v1", "key")
        self.assertEqual(client.base_url, 'https://example.com/api/v1')
        self.assertEqual(_safe({"n": 9007199254740993}), {"n": "9007199254740993"})

    def test_slurm_identity_and_rank_guard(self):
        with patch.dict(os.environ, {"SLURM_CLUSTER_NAME":"c", "SLURM_JOB_ID":"20", "SLURM_ARRAY_JOB_ID":"19", "SLURM_ARRAY_TASK_ID":"2"}, clear=True):
            self.assertEqual(TaskClient('x','https://example.com','key').worker_id, 'slurm:c:array-19:2')
        with patch.dict(os.environ, {"RANK":"1"}):
            with self.assertRaises(TaskError):
                self.client().claim()

    def test_claim_timeout_retains_exact_request(self):
        client = self.client()
        sent = []
        def attempt(pending):
            sent.append(pending.body)
            if len(sent) == 1:
                raise UncertainOperation(pending, 'lost reply')
            return {"tasks": []}
        client.retry = attempt
        with self.assertRaises(UncertainOperation):
            client.claim()
        self.assertEqual(client.claim(), [])
        self.assertEqual(sent[0], sent[1])

    def test_report_timeout_retains_runtime_and_item_id(self):
        client=self.client()
        task=Task(client, {"task_id":"t", "attempt_id":"a", "lease_token":"s", "lease_generation":1, "instance_epoch":"e", "data":{}, "tags":[]})
        sent=[]
        def attempt(pending):
            sent.append(pending.body)
            if len(sent)==1:
                raise UncertainOperation(pending, 'lost reply')
            return {"items":[{"status":"already_applied"}]}
        client.retry=attempt
        with self.assertRaises(UncertainOperation):
            task.complete({"value":0})
        task.complete({"value":0})
        self.assertEqual(sent[0],sent[1])
        self.assertEqual(PendingOperation.from_dict(task.client.prepare('claim',{}).to_dict()).endpoint,'claim')

    def test_no_retry_on_quota_or_auth(self):
        for status,code in [(503,'QUOTA_EXCEEDED'),(401,'UNAUTHENTICATED')]:
            client=self.client()
            with patch.object(client,'_transport',return_value=(status,{},json.dumps({"ok":False,"error":{"code":code,"message":"stop","retryable":False}}).encode())) as call:
                with self.assertRaises(TaskError):
                    client.claim()
                self.assertEqual(call.call_count,1)


    def test_process_recovery_preserves_prepared_runtime_and_changed_outcome_identity(self):
        client = self.client()
        task = Task(client, {"task_id":"t", "attempt_id":"a", "lease_token":"s", "lease_generation":1, "instance_epoch":"e", "data":{}, "tags":[]})
        def lose(operation):
            raise UncertainOperation(operation, "lost committed response")
        client.retry = lose
        with self.assertRaises(UncertainOperation):
            task.complete({"diameter": 9007199254740993})
        original = task.pending.body
        serialized = json.loads(json.dumps(task.to_handle()))
        restored_client = self.client()
        restored = restored_client.task_from_handle(serialized)
        self.assertEqual(restored.runtime_origin, "recovered")
        sent = []
        def acknowledge(operation):
            sent.append(operation.body)
            return {"items": [{"status": "already_applied"}]}
        restored_client.retry = acknowledge
        restored.complete({"diameter": 9007199254740993})
        self.assertEqual(sent, [original])
        self.assertNotIn("_client_state", restored.to_handle())
        changed = restored_client.task_from_handle(serialized)
        changed.complete({"diameter": 2})
        self.assertNotEqual(json.loads(sent[-1])["request_id"], json.loads(original)["request_id"])
        self.assertNotEqual(json.loads(sent[-1])["items"][0]["item_id"], json.loads(original)["items"][0]["item_id"])

if __name__ == '__main__':
    unittest.main()
