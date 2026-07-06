"""Stage 1y — annotate every word in the DB with POS, lemma, frequency, rarity.

One-shot migration: adds columns to the `words` table and fills them via
spaCy en_core_web_sm + wordfreq. Idempotent — re-running re-tags everything.

Output columns added to `words`:
  pos            spaCy POS tag (NOUN, VERB, ADJ, ADV, ADP, DET, ...)
  lemma          spaCy lemma_
  frequency      wordfreq.word_frequency(text, "en")
  rarity         min(6.0, -log10(freq))  (6.0 if freq <= 0)
  is_content     1 if pos in {NOUN, VERB, ADJ, ADV} else 0
  is_connective  1 if pos in {ADP, DET, CCONJ, SCONJ, PART, AUX, PRON}
                 OR lowercase text in CONNECTIVE_WORDS
"""

from __future__ import annotations

import math
import sqlite3

import spacy
from spacy.tokens import Doc
from wordfreq import word_frequency

from config import DB_PATH

CONTENT_POS = {"NOUN", "VERB", "ADJ", "ADV"}
CONNECTIVE_POS = {"ADP", "DET", "CCONJ", "SCONJ", "PART", "AUX", "PRON"}
CONNECTIVE_WORDS = {"the", "a", "an", "of", "in", "to", "and", "or", "but",
                    "with", "for", "from", "by", "at", "on", "is", "was",
                    "are", "were", "be", "been", "has", "have", "had",
                    "do", "does", "did", "will", "would", "could", "should",
                    "may", "might", "shall", "can", "must", "that", "which",
                    "who", "this", "it", "its", "not", "no", "so"}

NEW_COLS = {
    "pos": "TEXT",
    "lemma": "TEXT",
    "frequency": "REAL",
    "rarity": "REAL",
    "is_content": "INTEGER",
    "is_connective": "INTEGER",
}


def ensure_columns(db: sqlite3.Connection):
    existing = {r[1] for r in db.execute("PRAGMA table_info(words)").fetchall()}
    for col, typ in NEW_COLS.items():
        if col not in existing:
            db.execute(f"ALTER TABLE words ADD COLUMN {col} {typ}")
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_words_page_pos "
        "ON words (page_num, pos)"
    )
    db.commit()


def compute_rarity(freq: float) -> float:
    if freq <= 0:
        return 6.0
    return min(6.0, -math.log10(freq))


def main():
    print(f"DB: {DB_PATH}")
    db = sqlite3.connect(DB_PATH)
    ensure_columns(db)

    rows = db.execute("SELECT id, text FROM words ORDER BY id").fetchall()
    print(f"Tagging {len(rows):,} words ...")

    nlp = spacy.load("en_core_web_sm", disable=["parser", "ner"])

    # Build one-token Docs so each row gets exactly one token even if the
    # OCR'd "word" contains punctuation that spaCy would otherwise split.
    texts = [t for _, t in rows]
    docs = nlp.pipe(
        (Doc(nlp.vocab, words=[t]) for t in texts),
        batch_size=2000,
    )

    updates = []
    for (wid, text), doc in zip(rows, docs):
        if not len(doc):
            continue
        tok = doc[0]
        pos = tok.pos_
        lemma = tok.lemma_.lower()
        freq = word_frequency(text.lower(), "en")
        rarity = compute_rarity(freq)
        is_content = 1 if pos in CONTENT_POS else 0
        is_connective = 1 if (pos in CONNECTIVE_POS
                              or text.lower() in CONNECTIVE_WORDS) else 0
        updates.append((pos, lemma, freq, rarity, is_content, is_connective, wid))

    db.executemany(
        "UPDATE words SET pos=?, lemma=?, frequency=?, rarity=?, "
        "is_content=?, is_connective=? WHERE id=?",
        updates,
    )
    db.commit()

    n_null = db.execute("SELECT COUNT(*) FROM words WHERE pos IS NULL").fetchone()[0]
    n_content = db.execute("SELECT COUNT(*) FROM words WHERE is_content=1").fetchone()[0]
    n_conn = db.execute("SELECT COUNT(*) FROM words WHERE is_connective=1").fetchone()[0]
    print(f"  tagged: {len(updates):,}  unfilled: {n_null}")
    print(f"  is_content: {n_content:,}  is_connective: {n_conn:,}")

    db.close()


if __name__ == "__main__":
    main()
