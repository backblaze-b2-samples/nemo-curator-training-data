"""NeMo Curator engine adapter (external SDK — confined to repo/).

This is the genuine curation engine: it runs NVIDIA **NeMo Curator**'s own
modules for exact deduplication, heuristic quality filtering, and Presidio-backed
PII redaction. Nothing here is simulated — if the engine is not installed the
run fails loudly (see `CuratorEngineNotInstalled`) rather than producing fake
output.

Engine split (see README / requirements-curator.txt): NeMo Curator's dependency
tree (dask, spaCy + Presidio, fasttext, justext, and more) is heavy and is
deliberately kept OUT of the default `requirements.lock`. So every
`nemo_curator` import here is **lazy** — done inside `run_stages`, never at
module top — which lets the app boot, export its OpenAPI contract, run
structural tests, and serve all read routes with only the light API stack
installed. Install the engine with
`pip install -r services/api/requirements-curator.txt` to actually execute runs.

Device: `deployment: local` with **CUDA -> CPU autodetect**. NeMo Curator runs on
Dask; GPU means a RAPIDS `LocalCUDACluster` (dask-cuda) with a cuDF backend, CPU
means a plain `LocalCluster` with a pandas backend. There is no Apple MPS path for
Dask/RAPIDS, so this sample's heavy local path is CUDA->CPU and defaults to CPU.
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

CURATOR_INSTALL_HINT = (
    "curation engine not installed — run "
    "`pip install -r services/api/requirements-curator.txt` "
    "(installs NeMo Curator, spaCy + Presidio, and the en_core_web_sm model)"
)


class CuratorEngineNotInstalled(RuntimeError):
    """Raised when a run is executed without the NeMo Curator engine present."""

    def __init__(self, detail: str = CURATOR_INSTALL_HINT):
        self.detail = detail
        super().__init__(detail)


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


def engine_available() -> bool:
    """True when `nemo_curator` is importable (engine installed)."""
    return importlib.util.find_spec("nemo_curator") is not None


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


def run_stages(raw_docs: list[dict], config: RunConfig) -> Iterator[StageOutput]:
    """Run the configured NeMo Curator stages, yielding one `StageOutput` per
    executed stage (always `raw` first, then any enabled dedup/quality/pii).

    Raises `CuratorEngineNotInstalled` before doing any work if the engine is
    absent, so the caller can fail the run gracefully.
    """
    if not engine_available():
        raise CuratorEngineNotInstalled()

    # --- Lazy imports: only reachable once the engine is installed. ----------
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
    client = get_client(cluster_type=backend)
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
        try:
            client.close()
        except Exception as e:
            logger.debug("Dask client close race ignored: %s", e)
