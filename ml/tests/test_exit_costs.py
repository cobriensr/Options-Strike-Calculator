import math

import exit_engine.costs as costs


def test_constants_match_source():
    assert costs.COMMISSION_USD_PER_CONTRACT_RT == 0.65
    assert costs.SLIPPAGE_PCT_OF_SPREAD == 0.5


def test_apply_costs_strips_commission_and_two_leg_slippage():
    # entry_price=1.00 → commission = 0.65/(1.00*100)*100 = 0.65pp
    # spread_pct=4.0 → slippage = 2*0.5*4.0 = 4.0pp
    out = costs.apply_costs(100.0, entry_price=1.00, spread_pct_of_price=4.0)
    assert math.isclose(out, 100.0 - 0.65 - 4.0, rel_tol=1e-9)


def test_apply_costs_passthrough_on_bad_entry():
    assert costs.apply_costs(50.0, entry_price=0.0, spread_pct_of_price=2.0) == 50.0
