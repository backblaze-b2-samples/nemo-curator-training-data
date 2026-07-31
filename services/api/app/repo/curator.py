"""NeMo Curator engine adapter (external SDK — confined to repo/).

This is the genuine curation engine: it runs NVIDIA **NeMo Curator**'s own
modules for exact deduplication, heuristic quality filtering, and Presidio-backed
PII redaction. Nothing here is simulated — if the engine is not installed the
run fails loudly (see `CuratorEngineNotInstalled`) rather than producing fake
output.

Process model: each run's NeMo Curator pipeline executes in a **fresh spawned
subprocess** (`curator_worker`), NOT in the uvicorn process. NeMo Curator runs on
a Dask `distributed` LocalCluster; creating a second Dask cluster inside the
long-lived, multithreaded uvicorn server (the dev command is
`uvicorn --reload`, which adds a WatchFiles thread) deadlocks on macOS — the
first run works, the second wedges at 0% CPU with an orphaned `resource_tracker`,
regardless of nanny-subprocess vs in-process worker topology. Running each run in
a short-lived child (spawn, not fork — safe from a multithreaded process) means
the cluster is always the first-and-only one in a fresh process and is fully
reaped when the child exits, so iterative curation is safe across many runs. The
engine heavy-lifting and its lazy `nemo_curator` imports live in
`curator_worker`, so this module (and app boot / OpenAPI export / structural
tests) stays import-light and engine-free.

Device: `deployment: local` with **CUDA -> CPU autodetect**. NeMo Curator runs on
Dask; GPU means a RAPIDS `LocalCUDACluster` (dask-cuda) with a cuDF backend, CPU
means a plain `LocalCluster` with a pandas backend. There is no Apple MPS path for
Dask/RAPIDS, so this sample's heavy local path is CUDA->CPU and defaults to CPU.
"""

import importlib.util
import logging
import multiprocessing
import queue as queue_lib
from collections.abc import Iterator

from app.repo.curator_worker import StageOutput
from app.types.runs import RunConfig

logger = logging.getLogger(__name__)

CURATOR_INSTALL_HINT = (
    "curation engine not installed — run "
    "`pip install -r services/api/requirements-curator.txt` "
    "(installs NeMo Curator, spaCy + Presidio, and the en_core_web_lg model "
    "that Presidio loads for NER)"
)

# How long the parent waits between child-liveness checks while a stage runs, and
# how long it gives the child to exit on teardown before terminating it.
_POLL_TIMEOUT_S = 2.0
_JOIN_TIMEOUT_S = 30.0


class CuratorEngineNotInstalled(RuntimeError):
    """Raised when a run is executed without the NeMo Curator engine present."""

    def __init__(self, detail: str = CURATOR_INSTALL_HINT):
        self.detail = detail
        super().__init__(detail)


def engine_available() -> bool:
    """True when `nemo_curator` is importable (engine installed)."""
    return importlib.util.find_spec("nemo_curator") is not None


def run_stages(raw_docs: list[dict], config: RunConfig) -> Iterator[StageOutput]:
    """Run the configured NeMo Curator stages in an isolated subprocess, yielding
    one `StageOutput` per executed stage (always `raw` first, then any enabled
    dedup/quality/pii) as the child streams them back.

    Raises `CuratorEngineNotInstalled` before spawning anything if the engine is
    absent, so the caller can fail the run gracefully (and so the check is
    monkeypatchable in tests).
    """
    if not engine_available():
        raise CuratorEngineNotInstalled()

    # Import here (not module top) so `target=` is resolved from the spawn
    # context; the module itself is import-light and engine-free.
    from app.repo import curator_worker

    ctx = multiprocessing.get_context("spawn")
    result_queue = ctx.Queue()
    # Not daemonic: the child uses in-process (processes=False) Dask workers, so
    # it never spawns multiprocessing children, but daemonic processes are barred
    # from having any — the finally block reaps it deterministically instead.
    proc = ctx.Process(
        target=curator_worker.worker_main,
        args=(result_queue, raw_docs, config),
        name="nemo-curate-worker",
    )
    proc.start()
    logger.info("Curation subprocess started pid=%s", proc.pid)
    try:
        while True:
            try:
                msg = result_queue.get(timeout=_POLL_TIMEOUT_S)
            except queue_lib.Empty:
                # No message yet. If the child is still working, keep waiting; if
                # it has died without a terminal message, it crashed.
                if not proc.is_alive():
                    raise RuntimeError(
                        "Curation subprocess exited without producing a result"
                    ) from None
                continue
            tag = msg[0]
            if tag == "stage":
                yield msg[1]
            elif tag == "done":
                return
            elif tag == "error":
                raise RuntimeError(msg[1])
    finally:
        # Always reap the child so no orphaned process or dashboard port leaks
        # across runs, whether we exhausted the stages, errored, or the caller
        # closed the generator early.
        proc.join(timeout=_JOIN_TIMEOUT_S)
        if proc.is_alive():
            logger.warning(
                "Curation subprocess pid=%s did not exit; terminating", proc.pid
            )
            proc.terminate()
            proc.join(timeout=5)
        result_queue.close()
