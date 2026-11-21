#!/usr/bin/env node
/**
 * The pre-push guard for the nightly Railway service: .githooks/pre-push runs
 * it with git's stdin, and a push that would redeploy nightly during its run
 * (07:15-12:30 UTC) is refused. Logic, the rules and the override are in
 * scripts/_lib/nightly-push-window.mjs.
 *
 * Exit codes: 0 the push may go, 1 refused (the reason is on stderr).
 */
import { main } from './_lib/nightly-push-window.mjs';

process.exitCode = await main({
  stdin: process.stdin,
  env: process.env,
  now: new Date(),
});
