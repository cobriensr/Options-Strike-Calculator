# Analysis Output Schema — Reference Notes

## Overview

JSON Schema for the `full_response` JSONB column in PostgreSQL, derived from actual Opus 4.6 output across entry, midday, and review modes.

## Mode-Conditional Fields

All 17 top-level fields are always present in the JSON. Nullability varies by mode:

| Field             | entry                 | midday                | review                 |
| ----------------- | --------------------- | --------------------- | ---------------------- |
| `entryPlan`       | object                | object                | **null**               |
| `review`          | **null**              | **null**              | object                 |
| `strikeGuidance`  | object (if Periscope) | object (if Periscope) | object                 |
| `managementRules` | object                | object                | object (retrospective) |
| `periscopeNotes`  | string (if Periscope) | string (if Periscope) | string                 |
| `hedge`           | object                | object                | object                 |

## chartConfidence Signal Types

Different charts use different signal vocabularies:

| Key          | Signals                                      | Why                                                    |
| ------------ | -------------------------------------------- | ------------------------------------------------------ |
| `marketTide` | BEARISH, BULLISH, NEUTRAL, CONFLICTED        | Directional — this is the broad market signal          |
| `spxNetFlow` | Same + NOT PROVIDED                          | Directional — primary instrument, may not be uploaded  |
| `spyNetFlow` | CONFIRMS, CONTRADICTS, NEUTRAL, NOT PROVIDED | Confirmation role — measured against Market Tide + SPX |
| `qqqNetFlow` | CONFIRMS, CONTRADICTS, NEUTRAL, NOT PROVIDED | Confirmation role — tech sector divergence check       |
| `periscope`  | FAVORABLE, UNFAVORABLE, MIXED, NOT PROVIDED  | Structural — gamma positioning, not directional        |

## entryStep Schema

Each entry (entry1/2/3) has either `timing` (immediate) or `condition` (conditional), never both required:

- `timing`: "Now (9:05 AM CT / 10:05 AM ET)" — used for Entry 1
- `condition`: "At 10:00 AM CT: SPX still below 6725..." — used for Entry 2/3

Both are optional strings. `delta`, `structure`, `sizePercent`, and `note` are always required.

## Key Constraints

- `suggestedDelta`: 1-20 (integer)
- `sizePercent`: 5-100 per entry (integer)
- `observations`: 3-8 items
- `risks`: 1-5 items
- `lessonsLearned`: 1-8 items
- `imageIssues.imageIndex`: 1-6 (matches 6-image limit)
- `straddleCone.upper`/`lower`: number (not integer — allows decimals like 6735.27)

## Structured Outputs Considerations

If migrating to `output_config.format` with this schema:

1. **$defs references** need to be inlined — Anthropic structured outputs may not support `$ref` depending on implementation
2. **oneOf with null** (`"oneOf": [{"type": "null"}, {...}]`) is the pattern for nullable objects — verify this works with the structured outputs endpoint
3. **String lengths** are not constrained in this schema — Claude naturally produces paragraph-length content for `note`, `reasoning`, `structureRationale`, etc. Adding `maxLength` could truncate critical analysis
4. **The schema adds ~2,000 tokens** to the request when passed via `output_config.format` — this is cached with the system prompt if you add it there
