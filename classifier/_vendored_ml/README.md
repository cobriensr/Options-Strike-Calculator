# `_vendored_ml/` — copies of ml/src modules consumed by the classifier

Railway builds the classifier with build context `classifier/`, so Docker
COPY cannot reach `../ml/src/`. These files are byte-identical copies that
ship inside the container.

**Single source of truth:** `ml/src/multileg_assembler.py` and
`ml/src/multileg_patterns.py`. Edit there, then copy manually and commit
both sides (no Makefile target — `uw-stream/` doesn't have one either,
consistency is the goal).

`classifier/tests/test_vendored_ml_sync.py` asserts byte-equality and
will fail CI if the vendored copies drift from `ml/src/`.
