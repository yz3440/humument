"""Editor data-contract regression tests — one per invariant.

Each test runs a single validate_db check against the active-volume DB and
asserts it added no failures. Run the whole gate with `make verify` or:

    uv run pytest pipeline/tests -q
"""


def _run(validator, method_name):
    before = validator.failures
    getattr(validator, method_name)()
    assert validator.failures == before, f"{method_name} reported a failure"


def test_page_range(validator):
    _run(validator, "page_range")


def test_pages_exist_and_dims(validator):
    _run(validator, "pages_exist_and_dims")


def test_jpeg_dims_match(validator):
    _run(validator, "jpeg_dims_match")


def test_words_integrity(validator):
    _run(validator, "words_integrity")


def test_nlp_complete(validator):
    _run(validator, "nlp_complete")


def test_bbox_bounds(validator):
    _run(validator, "bbox_bounds")


def test_graph_present(validator):
    _run(validator, "graph_present")


def test_docks_present(validator):
    _run(validator, "docks_present")


def test_json_parses(validator):
    _run(validator, "json_parses")


def test_page_correspondence(validator):
    _run(validator, "page_correspondence")
