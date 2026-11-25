/**
 * The spec review gate's review log, as the pre-commit check reads it
 * (scripts/spec-review-check.mjs): parsing the log, keying a doc path, deciding
 * which docs have no review on record, the block messages, and where the log
 * is. Pure: nothing here reads a file or runs git.
 *
 * The log is <.claude>/state/spec-reviews.tsv, one event per line, written by
 * the bash hooks in .claude/hooks/ (local-only: that folder is not in the
 * repo). Six tab-separated fields: epoch event session agent key path, with
 * "-" for a field an event doesn't use. The check reads only `start`, `done`
 * and `waive`; the hooks also write `write`, `block`, `release`, `ask` and
 * `announced`, which parseLog keeps and `unreviewed` ignores.
 * Design: docs/superpowers/specs/2026-11-21-spec-review-gate-design.md, "The
 * pre-commit backstop".
 *
 * Node builtins only: .githooks/pre-commit runs the check in worktrees that
 * have no node_modules.
 */
import path from 'node:path';

/**
 * @typedef {object} LogEvent
 * @property {number} epoch Seconds since 1970.
 * @property {string} event `start`, `done`, `waive`, `write`, ...: any name.
 * @property {string} session
 * @property {string} agent
 * @property {string} key A doc key, `specs/<name>.md`, or "-".
 * @property {string} path
 */

const LOG_FIELDS = 6;

/**
 * The log's events. A line that isn't six tab-separated fields, or whose epoch
 * isn't a whole number, is skipped, so a hand edit or a torn write costs that
 * line and nothing else. Lines end in LF or CRLF: an editor on Windows may have
 * converted the file, and a trailing carriage return would sit in the path
 * field.
 *
 * @param {string} text
 * @returns {LogEvent[]}
 */
export function parseLog(text) {
  /** @type {LogEvent[]} */
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length !== LOG_FIELDS) continue;
    const [epoch = '', event = '', session = '', agent = '', key = '', p = ''] =
      fields;
    if (!/^\d+$/.test(epoch)) continue;
    events.push({
      epoch: Number(epoch),
      event,
      session,
      agent,
      key,
      path: p,
    });
  }
  return events;
}

/** The doc folder and name in a normalised path. The name is a run of these. */
const DOC_PATH = /docs\/superpowers\/(specs|plans)\/([a-z0-9._-]+)/g;

/**
 * The doc key a path names: `specs/<name>.md` or `plans/<name>.md`, or null.
 * The rule is the hooks' (srl_keys in .claude/hooks/_spec-review-lib.sh): the
 * path is normalised (each `\\` pair, then each single `\`, becomes `/`, then
 * it is lower-cased), and the key comes from the first
 * `docs/superpowers/(specs|plans)/<name>` in it whose name, once the periods
 * that end it are taken off, is at least one character and `.md`. Nothing is
 * needed before `docs/`, so a Windows path, an MSYS path and a repo-relative
 * path all key alike. (The hooks also rewrite a leading MSYS `/x/` as `x:/`, to
 * compare project folders. A key has no drive in it, so it makes no difference
 * here.) A name outside [a-z0-9._-], `a.mdx` and `a.md.bak` have no key. A
 * subfolder is read as the hooks read it: the first name after specs/ or
 * plans/ is the key's name, so `specs/x.md/y.md` keys as `specs/x.md`, while
 * `specs/sub/a.md` has none, since `sub` doesn't end in `.md`.
 *
 * @param {string} p
 * @returns {string | null}
 */
export function docKey(p) {
  const normalised = p
    .replaceAll('\\\\', '/')
    .replaceAll('\\', '/')
    .toLowerCase();
  for (const [, folder, rawName] of normalised.matchAll(DOC_PATH)) {
    let name = rawName ?? '';
    while (name.endsWith('.')) name = name.slice(0, -1);
    if (name.length > '.md'.length && name.endsWith('.md')) {
      return `${folder}/${name}`;
    }
  }
  return null;
}

/**
 * The paths with no review or waiver on record, in the order given. A doc is
 * reviewed when its key has a `start` and a `done` that share an agent id, in
 * either order (a foreground reviewer logs its done first; a brief that names
 * two docs gets one start per key and one done), or a `waive`. No time or
 * session condition: a commit can't tell when the doc was written. A path that
 * has no key (docKey is null) is listed too: nothing could ever record a
 * review or a waiver for it, and passing it would let a name dodge the gate.
 *
 * @param {string[]} paths
 * @param {LogEvent[]} events
 * @returns {string[]}
 */
export function unreviewed(paths, events) {
  const finished = new Set(
    events.filter((e) => e.event === 'done').map((e) => e.agent),
  );
  const settled = new Set([
    ...events.filter((e) => e.event === 'waive').map((e) => e.key),
    ...events
      .filter((e) => e.event === 'start' && finished.has(e.agent))
      .map((e) => e.key),
  ]);
  return paths.filter((p) => {
    const key = docKey(p);
    return key === null || !settled.has(key);
  });
}

/**
 * The paths as an indented list, then what to do about them. One waiver phrase
 * names every key: the owner's hook reads the list after "waive review". The
 * review and waiver line is for the docs that have a key. A doc with none can
 * have neither, so it gets only the rename line, and when no doc has a key that
 * is the only fix.
 *
 * @param {string[]} paths
 * @returns {string}
 */
function listAndFixes(paths) {
  const keys = [];
  const keyless = [];
  for (const p of paths) {
    const key = docKey(p);
    if (key === null) keyless.push(p);
    else keys.push(key);
  }
  const lines = paths.map((p) => `  ${p}`);
  if (keys.length > 0) {
    lines.push(
      `Run the spec-reviewer on each (CLAUDE.md, Plan First), or ask the owner to type "waive review ${keys.join(' ')}" at the start of a prompt. Then commit again.`,
    );
  }
  if (keyless.length > 0) {
    const pronoun = keyless.length === 1 ? 'it' : 'them';
    lines.push(
      `No review or waiver can name ${keyless.join(', ')}: a key needs a name of a-z, 0-9, ".", "_" and "-" directly under specs/ or plans/. Rename ${pronoun} before the commit.`,
    );
  }
  return lines.join('\n');
}

/**
 * What the check prints when docs have no review on record.
 *
 * @param {string[]} paths The unreviewed docs.
 * @returns {string}
 */
export function blockMessage(paths) {
  return `spec-review gate: commit blocked. These new docs have no spec-reviewer run and no waiver on record:\n${listAndFixes(paths)}`;
}

/**
 * What the check prints when there is no log at all.
 *
 * @param {string} logPath
 * @param {string[]} paths Every doc the commit adds.
 * @returns {string}
 */
export function missingLogMessage(logPath, paths) {
  return `spec-review gate: commit blocked. There is no review log at ${logPath}, so these new docs have no recorded review:\n${listAndFixes(paths)}`;
}

/**
 * Where the log is: beside the repository folder, in the main checkout's own
 * `.claude/state/`, whichever worktree runs the check. `gitCommonDir` is what
 * `git rev-parse --git-common-dir` printed in `cwd`: `.git` (or a path relative
 * to `cwd`) in a main checkout, the main checkout's absolute `.git` in a
 * worktree.
 *
 * @param {string} gitCommonDir
 * @param {string} cwd
 * @returns {string}
 */
export function logPathFor(gitCommonDir, cwd) {
  return path.join(
    path.dirname(path.resolve(cwd, gitCommonDir)),
    '.claude',
    'state',
    'spec-reviews.tsv',
  );
}
