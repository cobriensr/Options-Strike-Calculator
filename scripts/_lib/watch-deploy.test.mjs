// @vitest-environment node

/**
 * Tests for scripts/_lib/watch-deploy.mjs: the decision logic (a pure
 * function over the two GitHub payloads), the argument parser, the remote-url
 * parser, and the polling loop with `gh` mocked at the child_process module.
 * The CLI's exit code 3 paths, which need a real process, are in
 * watch-deploy.cli.test.mjs.
 *
 * watch-deploy-fixtures/status.json and check-runs.json are the real
 * `gh api repos/cobriensr/Options-Strike-Calculator/commits/<sha>/status`
 * and `.../check-runs` payloads for 01452ce7 (2026-11-04), trimmed to the
 * fields the script reads: 4 Railway statuses ("No deployment needed"), one
 * Vercel status, and 10 check runs, 5 of them skipped. Every other case
 * edits a copy of them.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from './git-run.mjs';
import {
  DEFAULT_TIMEOUT_MINUTES,
  PayloadError,
  POLL_INTERVAL_MS,
  UsageError,
  evaluateDeploy,
  ghAvailable,
  parseArgs,
  repoFromRemoteUrl,
  resolveRepo,
  watchDeploy,
} from './watch-deploy.mjs';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./git-run.mjs', () => ({ git: vi.fn() }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'watch-deploy-fixtures');
const readJson = (name) =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const STATUS = readJson('status.json');
const CHECK_RUNS = readJson('check-runs.json');

const SHA = '01452ce77b5c747b5283df230820dcfbae151182';

/** A fresh copy of the real payloads, as the `{ status, checkRuns }` input. */
function snapshot(edit) {
  const result = {
    status: structuredClone(STATUS),
    checkRuns: structuredClone(CHECK_RUNS),
  };
  edit?.(result);
  return result;
}

/** Merge `patch` into the check run called `name`. */
function patchCheck(snap, name, patch) {
  const run = snap.checkRuns.check_runs.find((r) => r.name === name);
  if (!run) throw new Error(`fixture has no check run ${name}`);
  Object.assign(run, patch);
}

/** Merge `patch` into the status with context `context`. */
function patchStatus(snap, context, patch) {
  const found = snap.status.statuses.find((s) => s.context === context);
  if (!found) throw new Error(`fixture has no status ${context}`);
  Object.assign(found, patch);
}

const evaluate = (edit) => evaluateDeploy(snapshot(edit));

describe('constants', () => {
  it('polls every 30 seconds and waits 30 minutes by default', () => {
    expect(POLL_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(30);
  });
});

describe('evaluateDeploy on the real payloads', () => {
  it('is done and successful when everything is success or skipped', () => {
    const result = evaluate();

    expect(result.done).toBe(true);
    expect(result.verdict).toBe('success');
    expect(result.pending).toEqual([]);
    expect(result.failing).toEqual([]);
    expect(result.summary).toBe('verdict: success (5 statuses, 10 check runs)');
  });

  it('prints one line per status and per check run, with its result', () => {
    const { lines } = evaluate();

    expect(lines).toHaveLength(15);
    expect(lines.filter((l) => l.startsWith('status'))).toHaveLength(5);
    expect(lines.filter((l) => l.startsWith('check'))).toHaveLength(10);

    const vercel = lines.find((l) => l.includes('Vercel'));
    expect(vercel).toContain('success');
    expect(vercel).toContain('Canceled by Ignored Build Step');

    const railway = lines.find((l) => l.includes('Theta-Options - sidecar'));
    expect(railway).toContain('success');
    expect(railway).toContain('No deployment needed');

    const e2e = lines.find((l) => l.includes('E2E Tests'));
    expect(e2e).toMatch(/skipped$/);
    const ml = lines.find((l) => l.includes('ML Quality Gate'));
    expect(ml).toMatch(/success$/);
  });

  it('orders lines by kind then name, whatever order GitHub sent', () => {
    const forward = evaluate().lines;
    const reversed = evaluate((snap) => {
      snap.status.statuses.reverse();
      snap.checkRuns.check_runs.reverse();
    }).lines;

    expect(reversed).toEqual(forward);
    const statusNames = forward
      .filter((l) => l.startsWith('status'))
      .map((l) => l.slice(7).split('  ')[0]?.trim());
    expect(statusNames).toEqual([...statusNames].sort());
  });

  it('counts skipped and neutral check runs as non-failures', () => {
    const result = evaluate((snap) => {
      patchCheck(snap, 'ML Quality Gate', { conclusion: 'neutral' });
    });
    expect(result.verdict).toBe('success');
    expect(result.lines.find((l) => l.includes('ML Quality Gate'))).toMatch(
      /neutral$/,
    );
  });
});

describe('evaluateDeploy: still waiting', () => {
  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'is not done while a check run is %s',
    (state) => {
      const result = evaluate((snap) => {
        patchCheck(snap, 'App Quality Gate', {
          status: state,
          conclusion: null,
        });
      });

      expect(result.done).toBe(false);
      expect(result.verdict).toBe('pending');
      expect(result.pending).toEqual(['App Quality Gate']);
      expect(result.summary).toBe(
        'verdict: pending (waiting on App Quality Gate)',
      );
      expect(result.lines.find((l) => l.includes('App Quality Gate'))).toMatch(
        new RegExp(`${state}$`),
      );
    },
  );

  it('is not done while a commit status is pending', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Vercel', {
        state: 'pending',
        description: 'Building',
      });
    });

    expect(result.done).toBe(false);
    expect(result.pending).toEqual(['Vercel']);
    expect(result.lines.find((l) => l.includes('Vercel'))).toContain('pending');
  });

  it('waits for the first check run, even when every status is success', () => {
    const result = evaluate((snap) => {
      snap.checkRuns = { total_count: 0, check_runs: [] };
    });

    expect(result.done).toBe(false);
    expect(result.verdict).toBe('pending');
    expect(result.summary).toBe(
      'verdict: pending (no check runs reported yet)',
    );
  });

  it('waits for the rest even after a failure, so the verdict is complete', () => {
    const result = evaluate((snap) => {
      patchCheck(snap, 'E2E Tests', { conclusion: 'failure' });
      patchCheck(snap, 'App Quality Gate', {
        status: 'in_progress',
        conclusion: null,
      });
    });

    expect(result.done).toBe(false);
    expect(result.verdict).toBe('pending');
    expect(result.failing).toEqual(['E2E Tests']);
    expect(result.pending).toEqual(['App Quality Gate']);
  });

  it('ignores the combined state, which reads pending for a commit with no statuses', () => {
    const result = evaluate((snap) => {
      snap.status = { state: 'pending', total_count: 0, statuses: [] };
    });

    expect(result.done).toBe(true);
    expect(result.verdict).toBe('success');
    expect(result.summary).toBe('verdict: success (0 statuses, 10 check runs)');
  });
});

describe('evaluateDeploy: failures', () => {
  it.each([
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'stale',
    'startup_failure',
  ])('fails on a check run concluded %s', (conclusion) => {
    const result = evaluate((snap) => {
      patchCheck(snap, 'E2E Tests', { conclusion });
    });

    expect(result.done).toBe(true);
    expect(result.verdict).toBe('failure');
    expect(result.failing).toEqual(['E2E Tests']);
    expect(result.summary).toBe(`verdict: failure (E2E Tests: ${conclusion})`);
  });

  it('fails on a completed check run with no conclusion', () => {
    const result = evaluate((snap) => {
      patchCheck(snap, 'E2E Tests', { conclusion: null });
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('E2E Tests: no conclusion');
  });

  it.each(['failure', 'error'])(
    'fails on a Vercel status in state %s',
    (state) => {
      const result = evaluate((snap) => {
        patchStatus(snap, 'Vercel', {
          state,
          description: 'Deployment failed',
        });
      });

      expect(result.done).toBe(true);
      expect(result.verdict).toBe('failure');
      expect(result.failing).toEqual(['Vercel']);
      expect(result.summary).toBe(`verdict: failure (Vercel: ${state})`);
    },
  );

  it('fails on a Railway status in state failure', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Theta-Options - uw-stream', {
        state: 'failure',
        description: 'Deploy failed',
      });
    });
    expect(result.verdict).toBe('failure');
    expect(result.failing).toEqual(['Theta-Options - uw-stream']);
  });

  it('fails on a status state it does not know', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Vercel', { state: 'exploded' });
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('Vercel: exploded');
  });

  it('names every failing item in the verdict and links each one', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Vercel', {
        state: 'failure',
        description: 'Deployment failed',
        target_url: 'https://vercel.com/TEAM/PROJECT/abc',
      });
      patchCheck(snap, 'E2E Tests', { conclusion: 'timed_out' });
    });

    expect(result.summary).toBe(
      'verdict: failure (Vercel: failure, E2E Tests: timed_out)',
    );
    expect(result.lines.find((l) => l.includes('Vercel'))).toContain(
      'https://vercel.com/TEAM/PROJECT/abc',
    );
    expect(result.lines.find((l) => l.includes('E2E Tests'))).toContain(
      'https://github.com/cobriensr/Options-Strike-Calculator/actions/runs/',
    );
  });
});

describe('evaluateDeploy: a canceled Vercel deployment', () => {
  it.each(['failure', 'error'])(
    'reports canceled and counts it as non-failing (state %s)',
    (state) => {
      const result = evaluate((snap) => {
        patchStatus(snap, 'Vercel', { state, description: 'Canceled' });
      });

      expect(result.done).toBe(true);
      expect(result.verdict).toBe('success');
      expect(result.failing).toEqual([]);
      const line = result.lines.find((l) => l.includes('Vercel'));
      expect(line).toContain('canceled');
      expect(line).toContain('non-failing');
      expect(line).toContain('superseded by a newer commit');
    },
  );

  it('recognises other wordings of a cancel', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Vercel', {
        state: 'error',
        description: 'Deployment canceled by a newer deployment',
      });
    });
    expect(result.verdict).toBe('success');
  });

  it('still fails a Vercel error that is not a cancel', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Vercel', {
        state: 'error',
        description: 'Build failed',
      });
    });
    expect(result.verdict).toBe('failure');
  });

  it('only forgives Vercel: a canceled Railway failure is still a failure', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Theta-Options - sidecar', {
        state: 'failure',
        description: 'Deployment canceled',
      });
    });
    expect(result.verdict).toBe('failure');
  });

  it('does not treat a pending Vercel status as canceled', () => {
    const result = evaluate((snap) => {
      patchStatus(snap, 'Vercel', {
        state: 'pending',
        description: 'Canceling previous deployment',
      });
    });
    expect(result.done).toBe(false);
  });
});

describe('evaluateDeploy: malformed payloads', () => {
  it.each([
    ['no statuses array', (s) => (s.status = { state: 'success' })],
    ['no check_runs array', (s) => (s.checkRuns = { total_count: 1 })],
    ['a null status payload', (s) => (s.status = null)],
    ['a status with no context', (s) => delete s.status.statuses[0].context],
    ['a status with no state', (s) => delete s.status.statuses[0].state],
    ['a check run with no name', (s) => delete s.checkRuns.check_runs[0].name],
    [
      'a check run with no status',
      (s) => delete s.checkRuns.check_runs[0].status,
    ],
  ])('throws a PayloadError for %s', (_label, edit) => {
    expect(() => evaluate(edit)).toThrow(PayloadError);
  });

  it('says which payload was wrong', () => {
    expect(() => evaluate((s) => (s.checkRuns = {}))).toThrow(/check-runs/);
    expect(() => evaluate((s) => (s.status = {}))).toThrow(/status/);
  });
});

describe('parseArgs', () => {
  it('takes a sha and defaults the timeout and repo', () => {
    expect(parseArgs([SHA])).toEqual({
      sha: SHA,
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      repo: null,
      help: false,
    });
  });

  it('accepts an abbreviated sha of 7 to 40 hex characters', () => {
    expect(parseArgs(['01452ce']).sha).toBe('01452ce');
    expect(parseArgs(['ABCDEF1234']).sha).toBe('ABCDEF1234');
  });

  it.each([
    [['--timeout', '5'], 5],
    [['--timeout=5'], 5],
    [['--timeout', '0.5'], 0.5],
    [['--timeout=90'], 90],
  ])('reads the timeout from %j', (extra, minutes) => {
    expect(parseArgs([SHA, ...extra]).timeoutMinutes).toBe(minutes);
  });

  it('takes flags before or after the sha', () => {
    const parsed = parseArgs(['--repo', 'a/b', SHA, '--timeout', '2']);
    expect(parsed).toMatchObject({ sha: SHA, repo: 'a/b', timeoutMinutes: 2 });
  });

  it('reads --repo in both spellings', () => {
    expect(
      parseArgs([SHA, '--repo=cobriensr/Options-Strike-Calculator']).repo,
    ).toBe('cobriensr/Options-Strike-Calculator');
    expect(parseArgs([SHA, '--repo', 'o/n.js']).repo).toBe('o/n.js');
  });

  it('returns help for -h and --help, without needing a sha', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it.each([
    ['no arguments', []],
    ['a non-hex sha', ['not-a-sha']],
    ['a sha that is too short', ['abc123']],
    ['a sha that is too long', ['a'.repeat(41)]],
    ['two shas', [SHA, SHA]],
    ['an unknown flag', [SHA, '--wait']],
    ['--timeout with no value', [SHA, '--timeout']],
    ['a zero timeout', [SHA, '--timeout', '0']],
    ['a negative timeout', [SHA, '--timeout', '-3']],
    ['a non-numeric timeout', [SHA, '--timeout', 'soon']],
    ['an infinite timeout', [SHA, '--timeout', 'Infinity']],
    ['--repo with no value', [SHA, '--repo']],
    ['a repo with no slash', [SHA, '--repo', 'options']],
    ['a repo with three parts', [SHA, '--repo', 'a/b/c']],
    ['a repo with a space', [SHA, '--repo', 'a/b c']],
  ])('throws a UsageError for %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe('repoFromRemoteUrl', () => {
  it.each([
    [
      'https://github.com/cobriensr/Options-Strike-Calculator.git',
      'cobriensr/Options-Strike-Calculator',
    ],
    [
      'https://github.com/cobriensr/Options-Strike-Calculator',
      'cobriensr/Options-Strike-Calculator',
    ],
    [
      'https://github.com/cobriensr/Options-Strike-Calculator.git\n',
      'cobriensr/Options-Strike-Calculator',
    ],
    [
      'git@github.com:cobriensr/Options-Strike-Calculator.git',
      'cobriensr/Options-Strike-Calculator',
    ],
    [
      'ssh://git@github.com/cobriensr/Options-Strike-Calculator.git',
      'cobriensr/Options-Strike-Calculator',
    ],
    ['https://x-access-token:s3cret@github.com/o/n.git', 'o/n'],
    ['https://github.com/o/n.js.git', 'o/n.js'],
  ])('reads %s', (url, repo) => {
    expect(repoFromRemoteUrl(url)).toBe(repo);
  });

  it.each([
    'https://gitlab.com/o/n.git',
    'https://example.com/github.com/o/n.git',
    'not a url',
    '',
    'https://github.com/only-owner',
  ])('returns null for %j', (url) => {
    expect(repoFromRemoteUrl(url)).toBeNull();
  });
});

describe('resolveRepo', () => {
  // A block body: vitest runs a function returned from beforeEach as cleanup,
  // and `mockReset()` returns the mock.
  beforeEach(() => {
    vi.mocked(git).mockReset();
  });

  it('reads owner/name from `git remote get-url origin`', () => {
    vi.mocked(git).mockReturnValue(
      'https://github.com/cobriensr/Options-Strike-Calculator.git\n',
    );

    expect(resolveRepo()).toBe('cobriensr/Options-Strike-Calculator');
    expect(vi.mocked(git).mock.calls[0]?.[0]).toEqual([
      'remote',
      'get-url',
      'origin',
    ]);
  });

  it('asks for --repo when git has no origin', () => {
    vi.mocked(git).mockImplementation(() => {
      throw new Error('git remote get-url origin: No such remote');
    });
    expect(() => resolveRepo()).toThrow(UsageError);
    expect(() => resolveRepo()).toThrow(/--repo/);
  });

  it('asks for --repo when the remote is not on GitHub', () => {
    vi.mocked(git).mockReturnValue('https://gitlab.com/o/n.git\n');
    expect(() => resolveRepo()).toThrow(/--repo/);
  });
});

/**
 * Script `gh` for the polling loop. `polls` is a list of snapshots, one per
 * poll (the last repeats); a poll is one status call plus one check-runs
 * call. An entry that is an Error makes that poll's calls fail the way
 * execFile does: an error plus the stderr of the process.
 */
function scriptGh(polls) {
  let checkRunCalls = 0;
  vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
    const endpoint = args[1];
    const isChecks = endpoint.includes('/check-runs');
    const poll = polls[Math.min(checkRunCalls, polls.length - 1)];
    if (isChecks) checkRunCalls += 1;
    if (poll instanceof Error) {
      callback(
        Object.assign(new Error('exit 1'), { code: 1 }),
        '',
        poll.message,
      );
    } else if (typeof poll === 'string') {
      callback(null, poll, '');
    } else {
      callback(
        null,
        JSON.stringify(isChecks ? poll.checkRuns : poll.status),
        '',
      );
    }
  });
  return { polls: () => checkRunCalls };
}

const pendingSnapshot = () =>
  snapshot((s) =>
    patchCheck(s, 'App Quality Gate', {
      status: 'in_progress',
      conclusion: null,
    }),
  );

describe('watchDeploy', () => {
  let out = [];
  let err = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(execFile).mockReset();
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((text) => out.push(text));
    vi.spyOn(console, 'error').mockImplementation((text) => err.push(text));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = (timeoutMinutes = 30) =>
    watchDeploy({ repo: 'o/n', sha: SHA, timeoutMinutes });

  it('returns 0 on the first poll when everything already passed', async () => {
    const gh = scriptGh([snapshot()]);

    await expect(run()).resolves.toBe(0);

    expect(gh.polls()).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0].split('\n')).toHaveLength(15);
    expect(out[1]).toBe('verdict: success (5 statuses, 10 check runs)');
  });

  it('calls gh api for the status and the check runs of the sha', async () => {
    scriptGh([snapshot()]);
    await run();

    const calls = vi
      .mocked(execFile)
      .mock.calls.map(([file, args]) => [file, ...args]);
    expect(calls).toContainEqual([
      'gh',
      'api',
      `repos/o/n/commits/${SHA}/status?per_page=100`,
    ]);
    expect(calls).toContainEqual([
      'gh',
      'api',
      `repos/o/n/commits/${SHA}/check-runs?per_page=100`,
    ]);
  });

  it('keeps polling every 30 seconds until everything settles, then returns 0', async () => {
    const gh = scriptGh([pendingSnapshot(), pendingSnapshot(), snapshot()]);
    const result = run();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(gh.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await expect(result).resolves.toBe(0);
    expect(gh.polls()).toBe(3);
    expect(out.at(-1)).toMatch(/^verdict: success/);
  });

  it('prints the table when it changes, not on every poll', async () => {
    scriptGh([pendingSnapshot(), pendingSnapshot(), snapshot()]);
    const result = run();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    await result;

    // pending table (once, though polled twice), final table, verdict.
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('in_progress');
    expect(out[1]).not.toContain('in_progress');
    expect(out[2]).toMatch(/^verdict:/);
  });

  it('says on stderr that it is still waiting, and on what', async () => {
    scriptGh([pendingSnapshot(), snapshot()]);
    const result = run();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await result;

    expect(err.some((l) => l.includes('waiting on App Quality Gate'))).toBe(
      true,
    );
  });

  it('returns 1 for a failure and prints the verdict naming it', async () => {
    scriptGh([
      snapshot((s) => patchCheck(s, 'E2E Tests', { conclusion: 'failure' })),
    ]);

    await expect(run()).resolves.toBe(1);
    expect(out.at(-1)).toBe('verdict: failure (E2E Tests: failure)');
  });

  it('returns 1 for a cancelled check run', async () => {
    scriptGh([
      snapshot((s) => patchCheck(s, 'E2E Tests', { conclusion: 'cancelled' })),
    ]);
    await expect(run()).resolves.toBe(1);
  });

  it('returns 0 when the only Vercel result is a canceled, superseded deploy', async () => {
    scriptGh([
      snapshot((s) =>
        patchStatus(s, 'Vercel', { state: 'failure', description: 'Canceled' }),
      ),
    ]);
    await expect(run()).resolves.toBe(0);
  });

  it('returns 2 at the timeout, after one last poll at the deadline', async () => {
    const gh = scriptGh([pendingSnapshot()]);
    const result = run(1);

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toBe(2);
    expect(gh.polls()).toBe(3); // t = 0, 30 s, 60 s
    expect(out.at(-1)).toBe(
      'verdict: timeout after 1 min, still waiting on App Quality Gate',
    );
  });

  it('waits no longer than the timeout when it is shorter than one interval', async () => {
    const gh = scriptGh([pendingSnapshot()]);
    const result = run(0.1); // 6 s

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toBe(2);
    expect(gh.polls()).toBe(2);
  });

  it('retries after a transient gh failure and carries on', async () => {
    const gh = scriptGh([new Error('gh: HTTP 502: Bad Gateway'), snapshot()]);
    const result = run();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await expect(result).resolves.toBe(0);
    expect(gh.polls()).toBe(2);
    expect(
      err.some((l) => l.includes('HTTP 502') && l.includes('retrying')),
    ).toBe(true);
  });

  it('keeps polling through a payload that is not JSON', async () => {
    scriptGh(['<html>Unicorn</html>', snapshot()]);
    const result = run();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await expect(result).resolves.toBe(0);
    expect(err.some((l) => l.includes('not JSON'))).toBe(true);
  });

  it('keeps polling through a payload with the wrong shape, and says why', async () => {
    scriptGh([{ status: {}, checkRuns: {} }, snapshot()]);
    const result = run();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await expect(result).resolves.toBe(0);
    expect(
      err.some((l) => l.includes('retrying') && l.includes('status')),
    ).toBe(true);
  });

  it('times out with exit 2 and the last error when gh never answers', async () => {
    scriptGh([new Error('gh: HTTP 503: Service Unavailable')]);
    const result = run(1);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toBe(2);
    expect(out.at(-1)).toBe(
      'verdict: timeout after 1 min, no answer from GitHub (last error: gh: HTTP 503: Service Unavailable)',
    );
  });

  it.each([
    ['gh: HTTP 404: Not Found'],
    ['gh: HTTP 401: Bad credentials'],
    ['gh: HTTP 422: No commit found for SHA: 0123456'],
    ['To get started with GitHub CLI, please run:  gh auth login'],
  ])('gives up at once with exit 3 on %s', async (stderr) => {
    const gh = scriptGh([new Error(stderr)]);

    await expect(run()).resolves.toBe(3);
    expect(gh.polls()).toBe(1);
    expect(err.join('\n')).toContain(stderr);
  });

  it('retries a 403 that is a rate limit, but not one that is a permission error', async () => {
    scriptGh([new Error('gh: API rate limit exceeded (HTTP 403)'), snapshot()]);
    const limited = run();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await expect(limited).resolves.toBe(0);

    scriptGh([new Error('gh: Resource not accessible (HTTP 403)')]);
    await expect(run()).resolves.toBe(3);
  });

  it('returns 3 when the gh binary is missing', async () => {
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      callback(
        Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
        '',
        '',
      );
    });

    await expect(run()).resolves.toBe(3);
    expect(err.join('\n')).toContain('`gh`');
  });
});

describe('ghAvailable', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it('is true when gh --version runs', async () => {
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      callback(null, 'gh version 2.65.0\n', '');
    });

    await expect(ghAvailable()).resolves.toBe(true);
    expect(vi.mocked(execFile).mock.calls[0]?.slice(0, 2)).toEqual([
      'gh',
      ['--version'],
    ]);
  });

  it('is false when gh is not installed', async () => {
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      callback(
        Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
        '',
        '',
      );
    });
    await expect(ghAvailable()).resolves.toBe(false);
  });
});
