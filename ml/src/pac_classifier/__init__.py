"""PAC event classifier — ML model that learns when PAC entries pay.

Entry point for Option A from `pac-event-classifier-2026-04-24.md`,
activated after the Phase 3 winner inspection found PAC has narrow
regime-conditional edge that flat config search can't reliably
capture (`pac-phase3-winner-inspection-2026-04-25.md`).

Modules:
    events   : extract BOS/CHoCH/CHOCH+ events from PACEngine output
    labels   : simulate +1.5R/-1R outcomes + signed-return regression target
    features : per-event feature snapshot (engine state at event ts)
    dataset  : assemble feature+label parquet for model training
"""
