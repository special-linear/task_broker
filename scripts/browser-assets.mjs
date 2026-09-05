import { mkdir, copyFile } from "node:fs/promises";
await mkdir("src/web/public/downloads", { recursive: true });
await copyFile("python/task_pool.py", "src/web/public/downloads/task_pool.py");
await copyFile("examples/minimal_worker.py", "src/web/public/downloads/minimal_worker.py");
