# Periscope controls probe — 2026-05-08T06-18-13-696Z

URL: https://unusualwhales.com/periscope/market-exposures-table

Each capture is a full body.outerHTML at the moment the dropdown
is open. Popovers in Radix render into a portal, so the option
list lives near the bottom of <body>, not next to the trigger.

## What to look for in each file

- `[role="menuitem"]` count → Radix menu pattern
- `[role="option"]` + `[role="listbox"]` count → Radix select pattern
- `[data-radix-popper-content-wrapper]` → Radix portal root
- Text like "14:50 - 15:00", "2026-05-07" inside the popover → option labels
