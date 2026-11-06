// @vitest-environment node

/**
 * REAL-SQL test for the ml_findings merge that ml/src/utils/__init__.py runs
 * for every pipeline section (`_MERGE_SECTION_SQL`).
 *
 * The statement is the whole point of the fix: it must change ONE section of
 * the singleton row and leave every other key alone. pytest cannot run it (no
 * database is allowed there, and psycopg2.connect is mocked), so the Python
 * tests only see that the right parameters are sent. This file reads the
 * shipped SQL text out of the Python source and runs it on pglite (real
 * Postgres in WASM) against the table built from migration #34, binding the
 * psycopg2 `%(name)s` placeholders to positional parameters.
 *
 * A SQL text that cannot be found fails the file; it never skips.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { applyMigration } from './pglite-migrations';

const PY_SOURCE = resolve(process.cwd(), 'ml/src/utils/__init__.py');
const SQL_ASSIGNMENT = /_MERGE_SECTION_SQL = """([\s\S]*?)"""/;

type Findings = Record<string, unknown>;

/** The shipped statement with `%(x)s` turned into `$n`; `names[n - 1]` is x. */
function loadMergeSql(): { text: string; names: string[] } {
  const match = SQL_ASSIGNMENT.exec(readFileSync(PY_SOURCE, 'utf8'));
  if (!match?.[1]) {
    throw new Error(`_MERGE_SECTION_SQL not found in ${PY_SOURCE}`);
  }
  const names: string[] = [];
  const text = match[1].replace(/%\((\w+)\)s/g, (_whole, name: string) => {
    let index = names.indexOf(name);
    if (index === -1) {
      names.push(name);
      index = names.length - 1;
    }
    return `$${index + 1}`;
  });
  return { text, names };
}

const MERGE = loadMergeSql();

let pg: PGlite;

/** Run the shipped merge the way save_section_findings calls it. */
async function merge(name: string, data: unknown, generatedAt: string) {
  const params: Record<string, string> = {
    name,
    data: JSON.stringify(data),
    generated_at: generatedAt,
  };
  await pg.query(
    MERGE.text,
    MERGE.names.map((n) => params[n]),
  );
}

/** Put a row in the table as an earlier run (or another machine) left it. */
async function seed(findings: Findings, updatedAt = '2026-04-25T20:52:56Z') {
  await pg.query(
    `INSERT INTO ml_findings (id, findings, updated_at)
     VALUES (1, $1::jsonb, $2::timestamptz)`,
    [JSON.stringify(findings), updatedAt],
  );
}

async function row() {
  const { rows } = await pg.query<{ findings: Findings; updated_at: Date }>(
    'SELECT findings, updated_at FROM ml_findings WHERE id = 1',
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  pg = new PGlite();
  await applyMigration(pg, 34);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.query('DELETE FROM ml_findings');
});

describe('_MERGE_SECTION_SQL on pglite', () => {
  it('reads exactly the three parameters the Python code sends', () => {
    expect([...MERGE.names].sort()).toEqual(['data', 'generated_at', 'name']);
    expect(MERGE.text).not.toMatch(/%/);
  });

  it('inserts the row, with generated_at and the section list, on an empty table', async () => {
    await merge('health', { status: 'WARN', warnings: ['a', null] }, 'T1');

    const { findings } = await row();
    expect(findings).toEqual({
      health: { status: 'WARN', warnings: ['a', null] },
      generated_at: 'T1',
      pipeline_sections: ['health'],
    });
  });

  it('changes only the named section, generated_at and pipeline_sections when the row exists', async () => {
    // eod_flow_baselines and the legacy structure_accuracy stand for sections
    // this machine never computed: they must survive, untouched.
    const before: Findings = {
      phase2: { best_model: 'Naive Bayes', accuracy: 0.7778 },
      dataset: { labeled_days: 42 },
      eod_flow_baselines: { rows: 18838326 },
      structure_accuracy: { legacy: true },
      health: { status: 'PASS' },
      generated_at: '2026-04-25T20:52:56+00:00',
      pipeline_sections: ['phase2', 'dataset', 'health'],
    };
    await seed(before);

    await merge('health', { status: 'WARN' }, '2026-11-05T00:00:00+00:00');

    const { findings } = await row();
    expect(findings).toEqual({
      ...before,
      health: { status: 'WARN' },
      generated_at: '2026-11-05T00:00:00+00:00',
      pipeline_sections: ['phase2', 'dataset', 'health'],
    });
    // Spelled out, so a failure names the section that was lost.
    expect(findings.phase2).toEqual(before.phase2);
    expect(findings.eod_flow_baselines).toEqual({ rows: 18838326 });
    expect(findings.structure_accuracy).toEqual({ legacy: true });
  });

  it('replaces the named section whole instead of merging into it', async () => {
    await seed({
      phase2: { best_model: 'Naive Bayes', stale_key: 1 },
      pipeline_sections: ['phase2'],
    });

    await merge('phase2', { best_model: 'XGBoost' }, 'T2');

    const { findings } = await row();
    expect(findings.phase2).toEqual({ best_model: 'XGBoost' });
  });

  it('appends a new section name to pipeline_sections', async () => {
    await seed({
      phase2: { x: 1 },
      pipeline_sections: ['phase2', 'dataset'],
    });

    await merge('periscope_gamma_wall_edge', { results: [] }, 'T3');

    const { findings } = await row();
    expect(findings.pipeline_sections).toEqual([
      'phase2',
      'dataset',
      'periscope_gamma_wall_edge',
    ]);
    expect(findings.phase2).toEqual({ x: 1 });
  });

  it('adds no duplicate when the name is already in pipeline_sections', async () => {
    await seed({
      phase2: { x: 1 },
      dataset: { y: 2 },
      pipeline_sections: ['phase2', 'dataset'],
    });

    await merge('phase2', { x: 2 }, 'T4');
    await merge('phase2', { x: 3 }, 'T5');

    const { findings } = await row();
    expect(findings.pipeline_sections).toEqual(['phase2', 'dataset']);
    expect(findings.phase2).toEqual({ x: 3 });
  });

  it('treats a name that is a prefix of a listed one as a different section', async () => {
    await seed({ b_two: { y: 1 }, pipeline_sections: ['b_two'] });

    await merge('b', { x: 1 }, 'T6');

    const { findings } = await row();
    expect(findings.pipeline_sections).toEqual(['b_two', 'b']);
  });

  it('creates pipeline_sections when the row has none, and keeps every other key', async () => {
    await seed({ a: { x: 1 }, generated_at: 'OLD' });

    await merge('b', { y: 2 }, 'T7');

    const { findings } = await row();
    expect(findings).toEqual({
      a: { x: 1 },
      b: { y: 2 },
      generated_at: 'T7',
      pipeline_sections: ['b'],
    });
  });

  it('advances updated_at and leaves one row', async () => {
    await seed(
      { a: { x: 1 }, pipeline_sections: ['a'] },
      '2026-01-01T00:00:00Z',
    );

    await merge('a', { x: 2 }, 'T8');
    await merge('b', { y: 1 }, 'T9');

    const { updated_at } = await row();
    expect(updated_at.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00Z').getTime(),
    );
  });
});
