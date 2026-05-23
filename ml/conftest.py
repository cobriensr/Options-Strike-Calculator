"""Configure pytest to find source modules in ml/src/ and cross-test
helpers in ml/tests/.

The takeit suite (test_takeit_export.py) reuses the synthetic-frame
builder from test_takeit_train.py to avoid duplicating the ~30-line
fixture, so the tests dir needs to be importable as well.
"""
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / "src"))
sys.path.insert(0, str(_HERE / "tests"))
