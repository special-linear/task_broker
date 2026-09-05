#!/bin/bash
#SBATCH --job-name=task-broker
#SBATCH --array=0-3
#SBATCH --time=02:00:00
set -euo pipefail
# Export TASK_MANAGER_URL and TASK_MANAGER_KEY before submitting this script.
export PYTHONPATH="${SLURM_SUBMIT_DIR}/python:${PYTHONPATH:-}"
python "${SLURM_SUBMIT_DIR}/examples/minimal_worker.py" "${TASK_MANAGER_POOL:-experiments}"
