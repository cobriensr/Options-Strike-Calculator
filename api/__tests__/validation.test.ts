// @vitest-environment node

/**
 * Zod schema tests for api/_lib/validation.ts.
 *
 * Validates the system-boundary input layer that protects the Anthropic
 * API + Postgres from malformed payloads. Focuses on:
 *   - Refinement logic (.refine() failures) — branch coverage was 46%
 *     because incidental coverage doesn't exercise rejection paths.
 *   - Regex / enum / size-limit boundaries.
 *   - Coerce + transform behavior.
 *
 * Happy paths are not exhaustively covered here — incidental coverage
 * from importer tests already exercises those. This file targets the
 * rejection paths a hostile request would take.
 */

import { describe, it, expect } from 'vitest';
import {
  guestKeySchema,
  zeroGammaQuerySchema,
  greekFlowQuerySchema,
  gexStrikeExpiryQuerySchema,
  dealerRegimeQuerySchema,
  ivAnomaliesQuerySchema,
  strikeTradeVolumeQuerySchema,
  ivAnomaliesCrossAssetBodySchema,
  periscopeImageSchema,
  periscopeChatBodySchema,
  periscopeChatUpdateBodySchema,
  periscopeChatImageQuerySchema,
  periscopeChatListQuerySchema,
  periscopeChatDetailQuerySchema,
  periscopeLessonsUpdateBodySchema,
  analyzeBodySchema,
  analyzeImageSchema,
  positionCsvSchema,
  preMarketBodySchema,
  alertAckSchema,
  lotteryFinderQuerySchema,
  silentBoomFeedQuerySchema,
  netFlowHistoryQuerySchema,
  tickerCandlesQuerySchema,
  lotteryContractTapeQuerySchema,
} from '../_lib/validation';

describe('guestKeySchema', () => {
  it('accepts an 8-128 char key', () => {
    expect(guestKeySchema.safeParse({ key: 'a'.repeat(24) }).success).toBe(
      true,
    );
  });

  it('rejects a 7-char key (under min)', () => {
    expect(guestKeySchema.safeParse({ key: 'short77' }).success).toBe(false);
  });

  it('rejects a 129-char key (over max)', () => {
    expect(guestKeySchema.safeParse({ key: 'a'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('rejects missing key', () => {
    expect(guestKeySchema.safeParse({}).success).toBe(false);
  });
});

describe('zeroGammaQuerySchema', () => {
  it('accepts uppercase 1-5 letter ticker', () => {
    expect(zeroGammaQuerySchema.safeParse({ ticker: 'SPX' }).success).toBe(
      true,
    );
  });

  it('rejects lowercase ticker', () => {
    expect(zeroGammaQuerySchema.safeParse({ ticker: 'spx' }).success).toBe(
      false,
    );
  });

  it('rejects ticker with digits', () => {
    expect(zeroGammaQuerySchema.safeParse({ ticker: 'SPX1' }).success).toBe(
      false,
    );
  });

  it('rejects malformed date', () => {
    expect(zeroGammaQuerySchema.safeParse({ date: '04/17/2026' }).success).toBe(
      false,
    );
  });

  it('accepts both fields omitted', () => {
    expect(zeroGammaQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe('greekFlowQuerySchema', () => {
  it('applies scope=0dte default', () => {
    const r = greekFlowQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scope).toBe('0dte');
  });

  it('accepts scope=all', () => {
    expect(greekFlowQuerySchema.safeParse({ scope: 'all' }).success).toBe(true);
  });

  it('rejects unknown scope', () => {
    expect(greekFlowQuerySchema.safeParse({ scope: 'weekly' }).success).toBe(
      false,
    );
  });
});

describe('gexStrikeExpiryQuerySchema', () => {
  it('accepts valid ticker + expiry', () => {
    expect(
      gexStrikeExpiryQuerySchema.safeParse({
        ticker: 'SPX',
        expiry: '2026-05-15',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown ticker', () => {
    expect(
      gexStrikeExpiryQuerySchema.safeParse({
        ticker: 'AAPL',
        expiry: '2026-05-15',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed expiry', () => {
    expect(
      gexStrikeExpiryQuerySchema.safeParse({
        ticker: 'SPX',
        expiry: '2026-5-15',
      }).success,
    ).toBe(false);
  });

  it('requires expiry', () => {
    expect(
      gexStrikeExpiryQuerySchema.safeParse({ ticker: 'SPX' }).success,
    ).toBe(false);
  });
});

describe('dealerRegimeQuerySchema — strict mode', () => {
  it('rejects unknown query keys (strict)', () => {
    expect(
      dealerRegimeQuerySchema.safeParse({ date: '2026-05-15', foo: 'bar' })
        .success,
    ).toBe(false);
  });

  it('accepts empty query', () => {
    expect(dealerRegimeQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts date + at', () => {
    expect(
      dealerRegimeQuerySchema.safeParse({
        date: '2026-05-15',
        at: '2026-05-15T14:30:00Z',
      }).success,
    ).toBe(true);
  });
});

describe('ivAnomaliesQuerySchema — refinement', () => {
  it('list mode (no strike/side/expiry) is valid', () => {
    expect(ivAnomaliesQuerySchema.safeParse({}).success).toBe(true);
  });

  it('history mode requires all four (strike+side+expiry+ticker)', () => {
    const partial = ivAnomaliesQuerySchema.safeParse({
      strike: 5800,
      side: 'call',
    });
    expect(partial.success).toBe(false);
  });

  it('strike without ticker is rejected', () => {
    const r = ivAnomaliesQuerySchema.safeParse({
      strike: 5800,
      side: 'call',
      expiry: '2026-05-15',
    });
    expect(r.success).toBe(false);
  });

  it('strike + side + expiry + ticker is accepted', () => {
    const r = ivAnomaliesQuerySchema.safeParse({
      ticker: 'SPY',
      strike: 580,
      side: 'call',
      expiry: '2026-05-15',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown ticker (not in STRIKE_IV_TICKERS)', () => {
    expect(ivAnomaliesQuerySchema.safeParse({ ticker: 'AAPL' }).success).toBe(
      false,
    );
  });

  it('limit is coerced from string and capped at 500', () => {
    expect(ivAnomaliesQuerySchema.safeParse({ limit: '50' }).success).toBe(
      true,
    );
    expect(ivAnomaliesQuerySchema.safeParse({ limit: '501' }).success).toBe(
      false,
    );
  });
});

describe('strikeTradeVolumeQuerySchema — refinement', () => {
  it('bulk mode (no strike/side) is accepted', () => {
    expect(
      strikeTradeVolumeQuerySchema.safeParse({
        ticker: 'SPY',
        since: '2026-05-15T13:30:00Z',
      }).success,
    ).toBe(true);
  });

  it('single-key mode (strike + side) is accepted', () => {
    expect(
      strikeTradeVolumeQuerySchema.safeParse({
        ticker: 'SPY',
        since: '2026-05-15T13:30:00Z',
        strike: 580,
        side: 'call',
      }).success,
    ).toBe(true);
  });

  it('rejects strike without side', () => {
    expect(
      strikeTradeVolumeQuerySchema.safeParse({
        ticker: 'SPY',
        since: '2026-05-15T13:30:00Z',
        strike: 580,
      }).success,
    ).toBe(false);
  });
});

describe('ivAnomaliesCrossAssetBodySchema', () => {
  const validKey = {
    ticker: 'SPY' as const,
    strike: 580,
    side: 'call' as const,
    expiry: '2026-05-15',
    alertTs: '2026-05-15T13:30:00Z',
  };

  it('accepts 1-200 keys', () => {
    expect(
      ivAnomaliesCrossAssetBodySchema.safeParse({ keys: [validKey] }).success,
    ).toBe(true);
  });

  it('rejects 0 keys', () => {
    expect(
      ivAnomaliesCrossAssetBodySchema.safeParse({ keys: [] }).success,
    ).toBe(false);
  });

  it('rejects 201 keys', () => {
    const keys = Array.from({ length: 201 }, () => ({ ...validKey }));
    expect(ivAnomaliesCrossAssetBodySchema.safeParse({ keys }).success).toBe(
      false,
    );
  });
});

describe('periscopeImageSchema + periscopeChatBodySchema', () => {
  const tinyImage = {
    kind: 'chart' as const,
    data: 'a'.repeat(1000),
    mediaType: 'image/png' as const,
  };

  it('rejects a single image over 10MB', () => {
    expect(
      periscopeImageSchema.safeParse({
        kind: 'chart',
        data: 'a'.repeat(10 * 1024 * 1024 + 1),
        mediaType: 'image/png',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown mediaType', () => {
    expect(
      periscopeImageSchema.safeParse({
        kind: 'chart',
        data: 'a',
        mediaType: 'image/svg+xml',
      }).success,
    ).toBe(false);
  });

  it('accepts 0 images (synthesizable mode)', () => {
    expect(
      periscopeChatBodySchema.safeParse({
        mode: 'pre_trade',
        images: [],
        read_date: '2026-05-15',
        read_time: '09:30',
      }).success,
    ).toBe(true);
  });

  it('rejects 4 images (>3 max)', () => {
    expect(
      periscopeChatBodySchema.safeParse({
        mode: 'pre_trade',
        images: [tinyImage, tinyImage, tinyImage, tinyImage],
        read_date: '2026-05-15',
        read_time: '09:30',
      }).success,
    ).toBe(false);
  });

  it('rejects debrief mode without parentId', () => {
    const r = periscopeChatBodySchema.safeParse({
      mode: 'debrief',
      images: [],
      read_date: '2026-05-15',
      read_time: '09:30',
    });
    expect(r.success).toBe(false);
  });

  it('rejects intraday mode without parentId', () => {
    const r = periscopeChatBodySchema.safeParse({
      mode: 'intraday',
      images: [],
      read_date: '2026-05-15',
      read_time: '12:00',
    });
    expect(r.success).toBe(false);
  });

  it('accepts intraday + parentId', () => {
    expect(
      periscopeChatBodySchema.safeParse({
        mode: 'intraday',
        images: [],
        parentId: 99,
        read_date: '2026-05-15',
        read_time: '12:00',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed read_time (no leading zero)', () => {
    expect(
      periscopeChatBodySchema.safeParse({
        mode: 'pre_trade',
        images: [],
        read_date: '2026-05-15',
        read_time: '9:30',
      }).success,
    ).toBe(false);
  });

  it('rejects combined size over 30MB', () => {
    const tenMb = {
      kind: 'chart' as const,
      data: 'a'.repeat(10 * 1024 * 1024),
      mediaType: 'image/png' as const,
    };
    // 3 × 10MB = 30MB + change pushes over.
    const r = periscopeChatBodySchema.safeParse({
      mode: 'pre_trade',
      images: [
        tenMb,
        tenMb,
        { ...tenMb, data: 'a'.repeat(10 * 1024 * 1024 + 1) },
      ],
      read_date: '2026-05-15',
      read_time: '09:30',
    });
    expect(r.success).toBe(false);
  });
});

describe('periscopeChatUpdateBodySchema', () => {
  it('accepts calibration_quality in [1, 5]', () => {
    expect(
      periscopeChatUpdateBodySchema.safeParse({ calibration_quality: 3 })
        .success,
    ).toBe(true);
  });

  it('rejects calibration_quality = 0 or 6', () => {
    expect(
      periscopeChatUpdateBodySchema.safeParse({ calibration_quality: 0 })
        .success,
    ).toBe(false);
    expect(
      periscopeChatUpdateBodySchema.safeParse({ calibration_quality: 6 })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown regime_tag', () => {
    expect(
      periscopeChatUpdateBodySchema.safeParse({ regime_tag: 'breakout' })
        .success,
    ).toBe(false);
  });

  it('accepts clear array with up to 2 fields', () => {
    expect(
      periscopeChatUpdateBodySchema.safeParse({
        clear: ['regime_tag', 'calibration_quality'],
      }).success,
    ).toBe(true);
  });
});

describe('periscopeChatImageQuerySchema (strict)', () => {
  it('coerces id from string and rejects unknown fields', () => {
    expect(
      periscopeChatImageQuerySchema.safeParse({ id: '42', kind: 'chart' })
        .success,
    ).toBe(true);
    expect(
      periscopeChatImageQuerySchema.safeParse({
        id: '42',
        kind: 'chart',
        extra: 'evil',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown kind', () => {
    expect(
      periscopeChatImageQuerySchema.safeParse({ id: '42', kind: 'iv' }).success,
    ).toBe(false);
  });

  it('rejects id = 0', () => {
    expect(
      periscopeChatImageQuerySchema.safeParse({ id: '0', kind: 'chart' })
        .success,
    ).toBe(false);
  });
});

describe('periscopeChatListQuerySchema', () => {
  it('default limit is 20', () => {
    const r = periscopeChatListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(20);
  });

  it('caps limit at 100', () => {
    expect(
      periscopeChatListQuerySchema.safeParse({ limit: '101' }).success,
    ).toBe(false);
  });

  it('rejects negative before', () => {
    expect(
      periscopeChatListQuerySchema.safeParse({ before: '-1' }).success,
    ).toBe(false);
  });

  it('accepts date', () => {
    expect(
      periscopeChatListQuerySchema.safeParse({ date: '2026-05-15' }).success,
    ).toBe(true);
  });
});

describe('analyzeBodySchema', () => {
  const tinyImage = {
    data: 'a'.repeat(100),
    mediaType: 'image/png' as const,
  };

  it('requires at least 1 image', () => {
    expect(
      analyzeBodySchema.safeParse({ images: [], context: {} }).success,
    ).toBe(false);
  });

  it('rejects more than 2 images', () => {
    expect(
      analyzeBodySchema.safeParse({
        images: [tinyImage, tinyImage, tinyImage],
        context: {},
      }).success,
    ).toBe(false);
  });

  it('rejects a single image over 5MB', () => {
    expect(
      analyzeImageSchema.safeParse({
        data: 'a'.repeat(5 * 1024 * 1024 + 1),
        mediaType: 'image/png',
      }).success,
    ).toBe(false);
  });
});

describe('positionCsvSchema', () => {
  it('rejects empty CSV', () => {
    expect(positionCsvSchema.safeParse({ csv: '' }).success).toBe(false);
  });

  it('rejects CSV over 1MB', () => {
    expect(
      positionCsvSchema.safeParse({ csv: 'a'.repeat(1_024_001) }).success,
    ).toBe(false);
  });
});

describe('preMarketBodySchema', () => {
  it('accepts numeric core fields + nullable optional', () => {
    expect(
      preMarketBodySchema.safeParse({
        date: '2026-05-15',
        globexHigh: 5800,
        globexLow: 5780,
        globexClose: 5790,
        globexVwap: null,
      }).success,
    ).toBe(true);
  });

  it('rejects non-ISO date', () => {
    expect(
      preMarketBodySchema.safeParse({
        date: '5/15/2026',
        globexHigh: 1,
        globexLow: 1,
        globexClose: 1,
      }).success,
    ).toBe(false);
  });
});

describe('alertAckSchema + periscopeChatDetailQuerySchema + periscopeLessonsUpdateBodySchema', () => {
  it('alertAckSchema rejects id = 0', () => {
    expect(alertAckSchema.safeParse({ id: 0 }).success).toBe(false);
  });

  it('alertAckSchema rejects non-integer id', () => {
    expect(alertAckSchema.safeParse({ id: 1.5 }).success).toBe(false);
  });

  it('periscopeChatDetailQuerySchema coerces id from string', () => {
    expect(periscopeChatDetailQuerySchema.safeParse({ id: '42' }).success).toBe(
      true,
    );
  });

  it('periscopeLessonsUpdateBodySchema rejects unknown action', () => {
    expect(
      periscopeLessonsUpdateBodySchema.safeParse({ id: 1, action: 'delete' })
        .success,
    ).toBe(false);
  });
});

describe('lotteryFinderQuerySchema — transforms', () => {
  it('transforms reload="true" to boolean true', () => {
    const r = lotteryFinderQuerySchema.safeParse({ reload: 'true' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reload).toBe(true);
  });

  it('transforms reload="false" to boolean false', () => {
    const r = lotteryFinderQuerySchema.safeParse({ reload: 'false' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reload).toBe(false);
  });

  it('default sort is chronological + default limit 50', () => {
    const r = lotteryFinderQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.sort).toBe('chronological');
      expect(r.data.limit).toBe(50);
    }
  });

  it('caps limit at 200', () => {
    expect(lotteryFinderQuerySchema.safeParse({ limit: '201' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown ticker shape (lowercase)', () => {
    expect(lotteryFinderQuerySchema.safeParse({ ticker: 'spy' }).success).toBe(
      false,
    );
  });
});

describe('silentBoomFeedQuerySchema', () => {
  it('default minVolOi=0, minSpikeRatio=0, limit=50', () => {
    const r = silentBoomFeedQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.minVolOi).toBe(0);
      expect(r.data.minSpikeRatio).toBe(0);
      expect(r.data.limit).toBe(50);
    }
  });

  it('rejects burst other than red/yellow/grey', () => {
    expect(
      silentBoomFeedQuerySchema.safeParse({ burst: 'green' }).success,
    ).toBe(false);
  });

  it('accepts dte ranges 0 / 1-3 / 4+', () => {
    for (const dte of ['0', '1-3', '4+'] as const) {
      expect(silentBoomFeedQuerySchema.safeParse({ dte }).success).toBe(true);
    }
  });
});

describe('netFlowHistoryQuerySchema + tickerCandlesQuerySchema + lotteryContractTapeQuerySchema', () => {
  it('netFlowHistoryQuerySchema requires ticker', () => {
    expect(netFlowHistoryQuerySchema.safeParse({}).success).toBe(false);
  });

  it('netFlowHistoryQuerySchema accepts ticker only', () => {
    expect(netFlowHistoryQuerySchema.safeParse({ ticker: 'SPY' }).success).toBe(
      true,
    );
  });

  it('netFlowHistoryQuerySchema rejects malformed from time', () => {
    expect(
      netFlowHistoryQuerySchema.safeParse({ ticker: 'SPY', from: '9:30' })
        .success,
    ).toBe(false);
  });

  it('tickerCandlesQuerySchema requires ticker', () => {
    expect(tickerCandlesQuerySchema.safeParse({}).success).toBe(false);
  });

  it('lotteryContractTapeQuerySchema validates OCC chain format', () => {
    expect(
      lotteryContractTapeQuerySchema.safeParse({ chain: 'SPY250515C00580000' })
        .success,
    ).toBe(true);
  });

  it('lotteryContractTapeQuerySchema rejects lowercase chain', () => {
    expect(
      lotteryContractTapeQuerySchema.safeParse({ chain: 'spy250515' }).success,
    ).toBe(false);
  });
});
