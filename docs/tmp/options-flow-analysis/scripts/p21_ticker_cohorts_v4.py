"""Phase 21 — per-ticker cohort summary on v4 trigger set.

Replicates p9's "5 personalities" categorization but on the v4 set with
proper full-session data + RE-LOAD overlay. Answers:
  * Which tickers are noise-heavy on v4? Are they the same as v3?
  * Which tickers respond best to the RE-LOAD signal?
  * Per-ticker best TOD and best flow_quad
  * Per-ticker time-to-peak profile

Definitions (no silent metric drift, consistent with p17/p18/p19/p20):
  * Subset = v3-style v4 (DTE=0, 34-ticker list, ask% ≥ 0.52)
  * "Win" = realized_multiple_eod ≥ 2.0
  * "Big win" = realized_multiple_eod ≥ 5.0
  * "Noise" = minutes_to_peak_eod < 5  (peaked within 5 min — same as p9)
  * "Patient" = minutes_to_peak_eod ≥ 60  (took ≥ 1h to peak)
  * RE-LOAD = entry_drop_pct_vs_prev ≤ -30 AND burst_ratio_vs_prev ≥ 2

Personalities (same buckets as p9):
  * fast_clean: high win rate + low noise rate
  * patient: high patient share, modest win
  * noise_heavy: high noise rate (>30% peak <5min) regardless of win
  * bimodal: substantial mass in BOTH noise and patient buckets (each >25%)
  * standard: everything else

Output:
  outputs/p21_ticker_cohorts_v4.csv
  outputs/p21_ticker_cohorts_v4.md (markdown table for sharing)
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def categorize(row) -> str:
    noise = row['noise_pct']
    patient = row['patient_pct']
    win = row['win_2x_pct']
    if noise > 30:
        return 'noise_heavy'
    if noise >= 25 and patient >= 25:
        return 'bimodal'
    if patient >= 50:
        return 'patient'
    if win >= 35 and noise < 20:
        return 'fast_clean'
    return 'standard'


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p17_v4_v3style.csv',
                     parse_dates=['date', 'trigger_time_ct', 'entry_time_ct'])
    print(f'Loaded {len(df):,} v3-style v4 fires')

    # Recompute prev-fire features (CSV may not carry them)
    df = df.sort_values(['date', 'option_chain_id', 'alert_seq']).reset_index(drop=True)
    grp = df.groupby(['date', 'option_chain_id'])
    df['prev_window_size'] = grp['trigger_window_size'].shift(1)
    df['prev_entry_price'] = grp['entry_price'].shift(1)
    df['burst_ratio_vs_prev'] = df['trigger_window_size'] / df['prev_window_size']
    df['entry_drop_pct_vs_prev'] = (
        (df['entry_price'] - df['prev_entry_price']) / df['prev_entry_price'] * 100
    )
    df['reload'] = ((df['burst_ratio_vs_prev'] >= 2)
                    & (df['entry_drop_pct_vs_prev'] <= -30)).fillna(False)

    df['noise'] = (df['minutes_to_peak_eod'] < 5).astype(int)
    df['patient'] = (df['minutes_to_peak_eod'] >= 60).astype(int)
    df['win_2x'] = (df['realized_multiple_eod'] >= 2.0).astype(int)
    df['big_win'] = (df['realized_multiple_eod'] >= 5.0).astype(int)

    # === Per-ticker summary ===
    rows = []
    for sym, g in df.groupby('underlying_symbol'):
        n = len(g)
        if n < 30:
            continue
        win_pct = g['win_2x'].mean() * 100
        big_pct = g['big_win'].mean() * 100
        noise_pct = g['noise'].mean() * 100
        patient_pct = g['patient'].mean() * 100
        med_mult = g['realized_multiple_eod'].median()
        med_ttp = g['minutes_to_peak_eod'].median()

        # RE-LOAD share + win rate
        rl = g.loc[g['reload']]
        rl_n = len(rl)
        rl_win = (rl['win_2x'].mean() * 100) if rl_n > 0 else 0.0
        rl_big = (rl['big_win'].mean() * 100) if rl_n > 0 else 0.0

        # Best TOD (by win rate, min n=15)
        best_tod = ''
        best_tod_win = 0.0
        for tod, gt in g.groupby('tod'):
            if len(gt) < 15:
                continue
            tw = gt['win_2x'].mean() * 100
            if tw > best_tod_win:
                best_tod_win = tw
                best_tod = f'{tod} ({tw:.0f}%, n={len(gt)})'

        # Call vs put split + best
        calls = g.loc[g['option_type'] == 'call']
        puts = g.loc[g['option_type'] == 'put']
        call_win = calls['win_2x'].mean() * 100 if len(calls) else 0.0
        put_win = puts['win_2x'].mean() * 100 if len(puts) else 0.0

        rows.append({
            'ticker': sym,
            'n': n,
            'win_2x_pct': round(win_pct, 1),
            'big_5x_pct': round(big_pct, 1),
            'noise_pct': round(noise_pct, 1),
            'patient_pct': round(patient_pct, 1),
            'med_mult': round(med_mult, 2),
            'med_ttp_min': round(med_ttp, 1),
            'reload_n': rl_n,
            'reload_win_2x_pct': round(rl_win, 1),
            'reload_big_5x_pct': round(rl_big, 1),
            'reload_lift_pct_pts': round(rl_win - win_pct, 1) if rl_n >= 5 else None,
            'best_tod': best_tod,
            'call_n': len(calls),
            'call_win_2x_pct': round(call_win, 1),
            'put_n': len(puts),
            'put_win_2x_pct': round(put_win, 1),
        })

    cohort = pd.DataFrame(rows).sort_values('win_2x_pct', ascending=False).reset_index(drop=True)
    cohort['personality'] = cohort.apply(categorize, axis=1)

    print('\n' + '=' * 95)
    print('=== PER-TICKER COHORT SUMMARY (v4 v3-style) — sorted by win_2x_pct ===')
    print('=' * 95)
    cols = ['ticker', 'n', 'win_2x_pct', 'big_5x_pct', 'noise_pct', 'patient_pct',
            'med_mult', 'med_ttp_min', 'reload_n', 'reload_win_2x_pct',
            'reload_lift_pct_pts', 'personality', 'best_tod']
    print(cohort[cols].to_string(index=False))

    # === Personality bucket summary ===
    print('\n' + '=' * 80)
    print('=== Personality bucket summary ===')
    print('=' * 80)
    for p, g in cohort.groupby('personality'):
        print(f'\n{p.upper()} ({len(g)} tickers):')
        print(f'  tickers: {", ".join(sorted(g["ticker"].tolist()))}')
        print(f'  median win_2x: {g["win_2x_pct"].median():.1f}%')
        print(f'  median noise:  {g["noise_pct"].median():.1f}%')
        print(f'  median TTP:    {g["med_ttp_min"].median():.0f} min')

    # === RE-LOAD impact ranking ===
    print('\n' + '=' * 80)
    print('=== Tickers most receptive to RE-LOAD (lift = RE-LOAD win - base win) ===')
    print('=' * 80)
    rl_rank = cohort.dropna(subset=['reload_lift_pct_pts']).sort_values(
        'reload_lift_pct_pts', ascending=False)
    print(f'\n{"ticker":<8s} {"n":>5s} {"base_win%":>10s} {"rl_n":>5s} {"rl_win%":>9s} '
          f'{"rl_big%":>9s} {"lift":>8s}')
    for _, r in rl_rank.iterrows():
        if r['reload_n'] < 5:
            continue
        print(f'{r["ticker"]:<8s} {int(r["n"]):>5d} {r["win_2x_pct"]:>9.1f}% '
              f'{int(r["reload_n"]):>5d} {r["reload_win_2x_pct"]:>8.1f}% '
              f'{r["reload_big_5x_pct"]:>8.1f}% {r["reload_lift_pct_pts"]:>+7.1f}pp')

    # === Save CSV ===
    cohort.to_csv(OUT / 'outputs' / 'p21_ticker_cohorts_v4.csv', index=False)
    print(f'\nSaved → outputs/p21_ticker_cohorts_v4.csv')

    # === Save markdown summary ===
    md_path = OUT / 'outputs' / 'p21_ticker_cohorts_v4.md'
    with md_path.open('w') as fh:
        fh.write('# Per-ticker cohort summary (v4 v3-style)\n\n')
        fh.write(f'Source: {len(df):,} v3-style filtered v4 fires across '
                 f'{cohort["ticker"].nunique()} tickers (≥30 fires/ticker)\n\n')
        fh.write('## Sorted by base win rate\n\n')
        fh.write(cohort[cols].to_markdown(index=False))
        fh.write('\n\n## Personality buckets\n\n')
        for p, g in cohort.groupby('personality'):
            fh.write(f'\n### {p}\n')
            fh.write(f'**{len(g)} tickers**: {", ".join(sorted(g["ticker"].tolist()))}\n\n')
    print(f'Saved → outputs/p21_ticker_cohorts_v4.md')


if __name__ == '__main__':
    main()
