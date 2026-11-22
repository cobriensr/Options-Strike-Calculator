import { readdirSync } from 'node:fs';

/**
 * Every .tsx file under `srcDir` that ships in the app, as a forward-slash
 * path from `srcDir`: not under a `__tests__` folder, and not a colocated test
 * file (a fixture there may hold a deliberate defect). The file walk shared by
 * the source guards (`no-generic-aria-name.test.ts`,
 * `no-title-only-generic.test.ts`).
 */
export function appSourceFiles(srcDir: string): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .map((p) => p.replaceAll('\\', '/'))
    .filter(
      (p) =>
        p.endsWith('.tsx') &&
        !/\.(test|spec)\.tsx$/.test(p) &&
        !p.split('/').includes('__tests__'),
    );
}
