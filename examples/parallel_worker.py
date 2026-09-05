from concurrent.futures import ProcessPoolExecutor
import os
from task_pool import TaskClient

def process(handle):
    # Pass the explicit task handle into the process that reports its result.
    client = TaskClient.from_env(os.environ.get("TASK_MANAGER_POOL", "experiments"))
    task = client.task_from_handle(handle)
    result = {"diameter": int(task.data["n"]) ** 2}
    return task.complete(result)

if __name__ == "__main__":
    # An explicit worker ID makes parent and subprocess identities agree.
    os.environ.setdefault("TASK_MANAGER_WORKER_ID", f"parallel:{os.getpid()}")
    client = TaskClient.from_env(os.environ.get("TASK_MANAGER_POOL", "experiments"))
    tasks = client.claim(4)
    with ProcessPoolExecutor(max_workers=4) as pool:
        print(list(pool.map(process, [task.to_handle() for task in tasks])))
