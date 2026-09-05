"""Set TASK_MANAGER_URL and TASK_MANAGER_KEY; put task_pool.py on PYTHONPATH."""
import sys
from task_pool import TaskClient

client = TaskClient.from_env(sys.argv[1] if len(sys.argv) > 1 else "experiments")
for task in client.claim(1):
    n = task.data["n"]
    task.complete({"diameter": int(n) ** 2})
    print(f"Completed {task.task_id}")
