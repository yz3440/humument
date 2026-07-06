# humument pipeline — convenience targets.
# The CV pipeline runs the numbered stages in order; `verify` is the gate that
# protects the data contract after any run or future PDF swap.

.PHONY: pipeline verify validate test typecheck

# Full pipeline (see pipeline/config.py). Word selection is done client-side in
# humument, so there is no word-selection stage here. Stage 03 exports the
# static JSON published as the humument-data npm package.
pipeline:
	uv run python pipeline/01a_rasterize.py
	uv run python pipeline/01b_ocr_raw.py
	uv run python pipeline/01c_correct_tilt.py
	uv run python pipeline/01d_normalize_color.py
	uv run python pipeline/01e_features.py
	uv run python pipeline/02_whitespace_graph.py
	uv run python pipeline/03_export_web.py

# Gate: DB invariants + page correspondence + lib type-checks.
verify: validate test typecheck

validate:
	uv run python pipeline/validate_db.py

test:
	uv run pytest pipeline/tests -q

typecheck:
	cd humument-lib && npm run typecheck
