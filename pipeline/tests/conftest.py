"""Put the flat `pipeline/` modules (config, validate_db) on the import path."""

import pathlib
import sqlite3
import sys

import pytest

PIPELINE_DIR = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINE_DIR))

import config  # noqa: E402
from validate_db import Validator  # noqa: E402


@pytest.fixture
def validator():
    if not config.DB_PATH.exists():
        pytest.skip(f"DB not found at {config.DB_PATH}; run the pipeline first")
    db = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    v = Validator(db, config.PDF_CONTENT_START, config.PDF_CONTENT_END)
    yield v
    db.close()
