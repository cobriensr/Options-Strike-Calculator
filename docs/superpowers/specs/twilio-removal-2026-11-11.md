# Remove Twilio SMS alerting (2026-11-11)

## Goal

Delete the Twilio SMS path. The owner never set it up, so the code only adds
an unused send path, four env vars and tests. Owner request, 2026-11-11.

## Phases

1. **Alert code** (small). `api/_lib/alerts.ts`: delete `sendTwilioSms` and
   the severity gate in `writeAlertIfNew`, and drop `sms_sent` from its
   INSERT. `api/_lib/alert-thresholds.ts`: delete `SMS_MIN_SEVERITY`. Update
   `api/__tests__/alerts-lib.test.ts` and `api/__tests__/alert-thresholds.test.ts`.
2. **Env vars** (small, one commit per R7). `api/_lib/env.ts`: delete the
   `twilio` schema and env group. Update `api/__tests__/env.test.ts`,
   `.env.example` and the CLAUDE.md env table.
3. **Docs** (small). `README.md` and `docs/ONBOARDING.md`: drop the Twilio
   mentions.

## Files

Listed per phase above. Nothing else in `api/`, `src/` or `scripts/` refers
to Twilio, `ALERT_PHONE_TO`, `SMS_MIN_SEVERITY` or `smsSent` (grep of
origin/main at a95f0085).

## Data dependencies

- `market_alerts.sms_sent` (migration in `api/_lib/db-migrations.ts`,
  `BOOLEAN DEFAULT FALSE`) stays. Dropping it would be a prod schema change
  for no gain. New rows take the default, and no code reads it.
- No npm package to remove: the send was a raw `fetch`.
- Vercel env vars `TWILIO_*` / `ALERT_PHONE_TO`, if any are set, are removed
  only with the owner's OK, after the code ships.

## Left as is

- Historical specs under `docs/superpowers/` and `docs/tmp/` that mention
  Twilio record what was true when written.
- `sidecar/src/main.py`'s docstring already says a Twilio-backed engine was
  removed.

## Open questions

None.
