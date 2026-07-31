"""Child-process curation engine (runs inside a fresh spawned subprocess).

Why a subprocess: `curator.run_stages` spawns ONE of these per run via
`multiprocessing` **spawn**. NeMo Curator runs on a Dask `distributed`
LocalCluster, and creating a *second* Dask cluster inside the long-lived,
multithreaded uvicorn server process deadlocks on macOS — the first run works,
the second wedges at 0% CPU (with an orphaned `resource_tracker`), independent of
nanny-subprocess vs in-process worker topology. Isolating each run in a
short-lived child means the cluster is ALWAYS the first-and-only cluster in a
fresh, single-threaded process (the case that always works) and is fully reaped
when the child exits. Spawn (not fork) starts a clean interpreter, so launching
it from the multithreaded server is safe.

This module stays importable without the engine present — every `nemo_curator`
import is lazy, inside `curate`. Nothing here touches Backblaze B2: the child
only curates the in-memory corpus and streams `StageOutput`s back to the parent,
which owns all B2 writes.
"""

import importlib.util
import json
import logging
import os
import tempfile
from collections.abc import Iterator
from typing import NamedTuple

from app.types.runs import RunConfig

logger = logging.getLogger(__name__)

# Heuristic-filter thresholds per quality preset. These map to NeMo Curator's
# built-in heuristic filters (word count, mean word length, symbol ratio,
# non-alpha ratio, repeated-line fraction). All CPU, no model download.
QUALITY_PRESETS: dict[str, dict] = {
    "lenient": {
        "min_words": 10,
        "max_words": 100_000,
        "max_symbol_to_word_ratio": 0.30,
        "max_non_alpha_numeric_to_text_ratio": 0.40,
        "max_repeated_line_fraction": 0.90,
    },
    "standard": {
        "min_words": 25,
        "max_words": 100_000,
        "max_symbol_to_word_ratio": 0.20,
        "max_non_alpha_numeric_to_text_ratio": 0.30,
        "max_repeated_line_fraction": 0.70,
    },
    "strict": {
        "min_words": 50,
        "max_words": 50_000,
        "max_symbol_to_word_ratio": 0.10,
        "max_non_alpha_numeric_to_text_ratio": 0.20,
        "max_repeated_line_fraction": 0.50,
    },
}

# Map our redaction modes to NeMo Curator PiiModifier anonymize actions.
REDACTION_ACTIONS = {"replace": "replace", "mask": "mask", "hash": "hash"}


class StageOutput(NamedTuple):
    stage: str
    docs: list[dict]
    docs_removed: int
    pii_spans_redacted: int
    detail: str | None


def select_backend() -> str:
    """Pick the compute backend: first available of CUDA -> CPU, default CPU.

    GPU is only chosen when BOTH a CUDA device and dask-cuda are present, since
    the RAPIDS path needs `LocalCUDACluster`. No Apple MPS path exists for
    Dask/RAPIDS, so MPS is intentionally not considered here.
    """
    try:
        import torch

        if torch.cuda.is_available() and importlib.util.find_spec("dask_cuda"):
            return "gpu"
    except Exception as e:
        logger.debug("CUDA probe failed, using CPU: %s", e)
    return "cpu"


def _write_jsonl(docs: list[dict], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for d in docs:
            f.write(json.dumps({"id": d["id"], "text": d["text"]}) + "\n")


def _to_records(dataset) -> list[dict]:
    """Materialize a NeMo Curator DocumentDataset to [{id, text}] records."""
    df = dataset.df.compute()
    if hasattr(df, "to_pandas"):  # cuDF -> pandas
        df = df.to_pandas()
    return [
        {"id": str(row["id"]), "text": str(row["text"])}
        for _, row in df[["id", "text"]].iterrows()
    ]


def _count_pii_spans(texts: list[str], entities: list[str]) -> int:
    """Best-effort count of PII spans, using the same Presidio engine NeMo
    Curator's PiiModifier wraps. Returns 0 if the analyzer can't be built."""
    try:
        from presidio_analyzer import AnalyzerEngine

        analyzer = AnalyzerEngine()
        return sum(
            len(analyzer.analyze(text=t, entities=entities, language="en"))
            for t in texts
        )
    except Exception as e:
        logger.warning("PII span count skipped: %s", e)
        return 0


def curate(raw_docs: list[dict], config: RunConfig) -> Iterator[StageOutput]:
    """Run the configured NeMo Curator stages, yielding one `StageOutput` per
    executed stage (always `raw` first, then any enabled dedup/quality/pii).

    Runs inside the spawned child; imports the engine lazily so this module is
    importable without it.
    """
    from nemo_curator import Modify, ScoreFilter, Sequential
    from nemo_curator.datasets import DocumentDataset
    from nemo_curator.filters import (
        MeanWordLengthFilter,
        NonAlphaNumericFilter,
        RepeatedLinesFilter,
        SymbolsToWordsFilter,
        WordCountFilter,
    )
    from nemo_curator.modifiers import PiiModifier
    from nemo_curator.modules import ExactDuplicates
    from nemo_curator.utils.distributed_utils import get_client

    backend = select_backend()
    df_backend = "cudf" if backend == "gpu" else "pandas"
    logger.info("Curation backend=%s (%s dataframe)", backend, df_backend)
    # This is a fresh, single-threaded child, so the cluster is the first and
    # only one in the process — safe to create. Use in-process THREADED workers
    # (processes=False) so the child spawns no nanny subprocesses of its own and
    # tears down cleanly on exit. GPU path is untouched (LocalCUDACluster is
    # always one process per visible CUDA device).
    if backend == "cpu":
        client = get_client(
            cluster_type=backend, n_workers=1, threads_per_worker=4, processes=False
        )
    else:
        client = get_client(cluster_type=backend, n_workers=2)
    tmpdir = tempfile.mkdtemp(prefix="nemo-curator-")
    try:
        # raw: the input, staged verbatim.
        yield StageOutput("raw", raw_docs, 0, 0, f"{len(raw_docs)} source documents")

        raw_path = os.path.join(tmpdir, "raw.jsonl")
        _write_jsonl(raw_docs, raw_path)
        dataset = DocumentDataset.read_json(
            raw_path, backend=df_backend, add_filename=False
        )

        # --- deduplicate (exact) ---------------------------------------------
        if config.dedup_enabled:
            before = len(_to_records(dataset))
            dedup = ExactDuplicates(
                id_field="id", text_field="text", hash_method="md5"
            )
            duplicates = dedup(dataset)
            dup_ids = {str(x) for x in duplicates.df["id"].compute().tolist()}
            kept = dataset.df[~dataset.df["id"].astype(str).isin(list(dup_ids))]
            dataset = DocumentDataset(kept)
            docs = _to_records(dataset)
            removed = before - len(docs)
            mode = "exact + fuzzy" if config.dedup_mode == "exact_fuzzy" else "exact"
            yield StageOutput(
                "deduped", docs, removed, 0, f"{mode} dedup removed {removed}"
            )

        # --- quality filter (heuristic) --------------------------------------
        if config.quality_enabled:
            before = len(_to_records(dataset))
            t = QUALITY_PRESETS[config.quality_preset]
            pipeline = Sequential(
                [
                    ScoreFilter(
                        WordCountFilter(
                            min_words=t["min_words"], max_words=t["max_words"]
                        ),
                        text_field="text",
                    ),
                    ScoreFilter(MeanWordLengthFilter(), text_field="text"),
                    ScoreFilter(
                        SymbolsToWordsFilter(
                            max_symbol_to_word_ratio=t["max_symbol_to_word_ratio"]
                        ),
                        text_field="text",
                    ),
                    ScoreFilter(
                        NonAlphaNumericFilter(
                            max_non_alpha_numeric_to_text_ratio=t[
                                "max_non_alpha_numeric_to_text_ratio"
                            ]
                        ),
                        text_field="text",
                    ),
                    ScoreFilter(
                        RepeatedLinesFilter(
                            max_repeated_line_fraction=t["max_repeated_line_fraction"]
                        ),
                        text_field="text",
                    ),
                ]
            )
            dataset = pipeline(dataset)
            docs = _to_records(dataset)
            removed = before - len(docs)
            yield StageOutput(
                "filtered",
                docs,
                removed,
                0,
                f"{config.quality_preset} preset pruned {removed}",
            )

        # --- PII redaction (Presidio) ----------------------------------------
        if config.pii_enabled:
            before_docs = _to_records(dataset)
            spans = _count_pii_spans(
                [d["text"] for d in before_docs], config.pii_entities
            )
            action = REDACTION_ACTIONS[config.redaction_mode]
            modify = Modify(
                PiiModifier(
                    language="en",
                    supported_entities=config.pii_entities,
                    anonymize_action=action,
                    batch_size=1000,
                    device=backend,
                ),
                text_field="text",
            )
            dataset = modify(dataset)
            docs = _to_records(dataset)
            yield StageOutput(
                "redacted", docs, 0, spans, f"{action} redaction over {spans} spans"
            )
    finally:
        # Tear the cluster down even though this child is exiting anyway: it
        # releases the :8787 dashboard port and Dask scratch dir promptly, each
        # guarded independently so one failing still attempts the other.
        cluster = getattr(client, "cluster", None)
        try:
            client.close()
        except Exception as e:
            logger.debug("Dask client close race ignored: %s", e)
        try:
            if cluster is not None:
                cluster.close()
        except Exception as e:
            logger.debug("Dask cluster close race ignored: %s", e)


def worker_main(result_queue, raw_docs: list[dict], config: RunConfig) -> None:
    """Spawn entry point: run `curate` and stream results over `result_queue`.

    Protocol: one `("stage", StageOutput)` per stage, then a single terminal
    `("done",)` on success or `("error", detail)` on failure. Must be a
    module-level function so `multiprocessing` spawn can import it by name.
    """
    try:
        for out in curate(raw_docs, config):
            result_queue.put(("stage", out))
        result_queue.put(("done",))
    except Exception as e:  # relay ANY failure to the parent
        logger.exception("Curation subprocess failed")
        result_queue.put(("error", f"{type(e).__name__}: {e}"))
    finally:
        # Flush the queue's feeder thread before the interpreter tears down so
        # the parent reliably receives the terminal message.
        result_queue.close()
        result_queue.join_thread()
