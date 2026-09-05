"""torchrun --standalone --nproc-per-node=2 examples/torchrun_worker.py

torch is needed by this example, not by task_pool.py.
"""
import torch.distributed as dist
from task_pool import TaskClient

dist.init_process_group("gloo")
rank = dist.get_rank()
client = TaskClient.from_env("experiments") if rank == 0 else None
tasks = client.claim(1) if client else []
payload = [tasks[0].data if tasks else None]
dist.broadcast_object_list(payload, src=0)
if payload[0] is not None:
    result = int(payload[0]["n"]) ** 2
    if rank == 0:
        tasks[0].complete({"diameter": result})
dist.destroy_process_group()
