# `_vendored_ml/` — copies of ml/src modules consumed by the sidecar

Railway builds the sidecar with build context `sidecar/`, so Docker COPY
cannot reach `../ml/src/`. These files are byte-identical copies that
ship inside the container.

**Single source of truth:** `ml/src/multileg_assembler.py` and
`ml/src/multileg_patterns.py`. Edit there, then run `make sync-ml`
(or copy manually) and commit both sides.

`tests/test_vendored_ml_sync.py` asserts byte-equality and will fail
CI if the vendored copies drift from `ml/src/`.
