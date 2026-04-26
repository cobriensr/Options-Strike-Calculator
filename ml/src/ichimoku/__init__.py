"""Ichimoku Kinko Hyo signal engine.

Computes the five Ichimoku lines (Tenkan, Kijun, Senkou A/B, Chikou),
the cloud, and emits per-bar event signals (TK cross, cloud break) in
the SAME column schema as `pac.PACEngine` so the existing
`pac_classifier` events → labels → features → dataset pipeline runs
unmodified. Only the upstream signal-extraction step changes.

Mapping from Ichimoku events to the PAC schema columns:

    BOS         <- TK cross (Tenkan crosses Kijun)
    CHOCH       <- cloud break (close crosses Senkou A/B envelope)
    CHOCHPlus   <- TK cross AND price relative to cloud agree
                   (TK cross up while close above cloud, or
                   TK cross down while close below cloud)

Sign convention is preserved (+1 = bullish, -1 = bearish), so the
existing labels module's long/short stop+target logic works as-is.
"""

from ichimoku.engine import IchimokuEngine

__all__ = ["IchimokuEngine"]
