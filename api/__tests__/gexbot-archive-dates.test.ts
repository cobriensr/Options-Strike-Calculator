// @vitest-environment node

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRetry } = vi.hoisted(() => ({
  mockRetry: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('../_lib/db.js', () => ({ withDbRetry: mockRetry }));

import { listUnarchivedDates } from '../_lib/gexbot-archive-dates.js';

const mockSql = vi.fn();
const sql = mockSql as unknown as NeonQueryFunction<false, false>;

function sqlText(): string {
  return (mockSql.mock.calls[0]![0] as readonly string[]).join('?');
}

describe('listUnarchivedDates', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockRetry.mockClear();
  });

  it('returns [] when the query returns no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(
      await listUnarchivedDates(sql, 'gexbot_snapshots', '2026-10-02'),
    ).toEqual([]);
  });

  it('returns the dates as strings in query order', async () => {
    mockSql.mockResolvedValueOnce([{ d: '2026-09-08' }, { d: '2026-09-09' }]);
    expect(
      await listUnarchivedDates(sql, 'gexbot_api_capture', '2026-10-02'),
    ).toEqual(['2026-09-08', '2026-09-09']);
  });

  it('queries only the requested table', async () => {
    mockSql.mockResolvedValueOnce([]);
    await listUnarchivedDates(sql, 'gexbot_snapshots', '2026-10-02');
    expect(sqlText()).toContain('gexbot_snapshots');
    expect(sqlText()).not.toContain('gexbot_api_capture');

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]);
    await listUnarchivedDates(sql, 'gexbot_api_capture', '2026-10-02');
    expect(sqlText()).toContain('gexbot_api_capture');
    expect(sqlText()).not.toContain('gexbot_snapshots');
  });

  it('anti-joins against gexbot_archive_audit for the same table', async () => {
    mockSql.mockResolvedValueOnce([]);
    await listUnarchivedDates(sql, 'gexbot_snapshots', '2026-10-02');
    expect(sqlText()).toContain('gexbot_archive_audit');
    expect(sqlText()).toContain('ORDER BY d');
  });

  it('keeps both table branches identical apart from the table name', async () => {
    mockSql.mockResolvedValue([]);
    await listUnarchivedDates(sql, 'gexbot_snapshots', '2026-10-02');
    const snap = sqlText().replaceAll('gexbot_snapshots', 'T');
    mockSql.mockClear();
    await listUnarchivedDates(sql, 'gexbot_api_capture', '2026-10-02');
    const cap = sqlText().replaceAll('gexbot_api_capture', 'T');
    expect(snap).toBe(cap);
    expect(snap).toContain('captured_at >= days.d::timestamptz');
    expect(snap).toContain('captured_at < (days.d + 1)::timestamptz');
    expect(snap).toContain('::date - 1');
  });

  it('wraps the query in withDbRetry with 2 retries and a 10s timeout', async () => {
    mockSql.mockResolvedValueOnce([]);
    await listUnarchivedDates(sql, 'gexbot_snapshots', '2026-10-02');
    expect(mockRetry).toHaveBeenCalledWith(expect.any(Function), 2, 10_000);
  });

  it('passes beforeDate as a query parameter', async () => {
    mockSql.mockResolvedValueOnce([]);
    await listUnarchivedDates(sql, 'gexbot_snapshots', '2026-10-02');
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain('2026-10-02');
    expect(sqlText()).not.toContain('2026-10-02');
  });

  it('propagates a rejected query', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));
    await expect(
      listUnarchivedDates(sql, 'gexbot_api_capture', '2026-10-02'),
    ).rejects.toThrow('boom');
  });
});
