#!/usr/bin/env node
// Writes api/_lib/build-info.ts with the current commit SHA so the
// /api/version endpoint can return what was actually bundled into its
// Function. Pairs with Vite's __BUILD_SHA__ define for end-to-end
// stale-cache detection (see feat(observability) commit 08da74f9).
import { readFileSync, writeFileSync } from 'node:fs';

function readLocalSha() {
  try {
    const head = readFileSync('.git/HEAD', 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      return readFileSync(`.git/${ref}`, 'utf8').trim();
    }
    return head;
  } catch {
    return 'local';
  }
}

const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? readLocalSha()).slice(0, 7);
const content = `// GENERATED FILE — do not edit by hand.
// Overwritten on every build by scripts/write-build-info.mjs.
export const BUILD_SHA = '${sha}';
`;
writeFileSync('api/_lib/build-info.ts', content);
console.log('[build-info] BUILD_SHA =', sha);
