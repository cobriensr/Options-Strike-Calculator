import math

import numpy as np
import pandas as pd

import exit_engine.labels as lbl


def test_forward_ratio_uses_future_max_from_here():
    path = pd.DataFrame({"mid": [1.0, 2.0, 4.0, 3.0]})
    out = lbl.add_labels(path, theta=0.15)
    # from idx0 future max=4 -> ratio 4.0; idx2 future max=4 -> ratio 1.0
    assert list(out["forward_ratio"]) == [4.0, 2.0, 1.0, 1.0]
    # classification: ratio-1 >= 0.15
    assert list(out["y_has_upside"]) == [1, 1, 0, 0]
    # regression: log1p(ratio-1); last point has 0 upside
    assert math.isclose(out["y_log_upside"].iloc[0], math.log1p(3.0))
    assert out["y_log_upside"].iloc[-1] == 0.0


def test_labels_are_strictly_forward_no_leak_backward():
    # An early dip then recovery: idx0 still sees the later peak.
    path = pd.DataFrame({"mid": [2.0, 1.0, 10.0]})
    out = lbl.add_labels(path, theta=0.15)
    assert out["forward_ratio"].iloc[0] == 5.0  # 10/2
    assert out["forward_ratio"].iloc[1] == 10.0  # 10/1
