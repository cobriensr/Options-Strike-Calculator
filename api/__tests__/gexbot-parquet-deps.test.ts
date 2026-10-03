// @vitest-environment node
//
// uuid >= 12 ships ESM-only. thrift (pulled in by @dsnp/parquetjs for the
// GexBot archive) require()s it, and Vercel's Node loader does not support
// require(esm), so archive-gexbot crashed at module load from 2026-09-08 to
// 2026-10-02. This test fails if a future lockfile sync re-floats uuid past 11.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootRequire = createRequire(import.meta.url);
const thriftPkgPath = rootRequire.resolve('thrift/package.json');
const thriftRequire = createRequire(thriftPkgPath);
const uuidEntry = thriftRequire.resolve('uuid');

function findPackageRoot(entry: string): string {
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
      };
      if (pkg.name === 'uuid') return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`No uuid package.json above ${entry}`);
}

describe('thrift uuid resolution (CommonJS guard)', () => {
  it('resolves a uuid version <= 11 from thrift', () => {
    const root = findPackageRoot(uuidEntry);
    const { version } = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(Number.parseInt(version, 10)).toBeLessThanOrEqual(11);
  });

  it('resolves a CommonJS entry file, not an ESM-only build', () => {
    const normalized = uuidEntry.split(path.sep).join('/');
    expect(normalized).not.toMatch(/\/dist\/esm\//);
    expect(normalized).not.toMatch(/\/dist-node\//);
  });
});
