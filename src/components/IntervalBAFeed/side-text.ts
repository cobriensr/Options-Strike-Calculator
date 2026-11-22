/**
 * Text for the CALL / PUT side pill of an Interval B/A alert, shared by the
 * live toast (`IntervalBAAlertBanner`) and the feed row (`IntervalBARow`), so
 * the two pills cannot drift apart. Both tables are keyed by the alert's
 * `option_type` (`C` = call, `P` = put).
 *
 * A plain module, not a component file, so `react-refresh/only-export-components`
 * stays quiet about the constants.
 */

/**
 * The pill's mouse-hover `title`: the pill's own word, then the sentence.
 * Tests pin both strings in full.
 */
export const SIDE_TITLE: Record<'C' | 'P', string> = {
  C: 'CALL — ask-side buyers paid up for upside calls. Bullish directional bet.',
  P: 'PUT — ask-side buyers paid up for downside puts. Bearish directional bet.',
};

/**
 * Screen-reader hint for the pill. The pill shows only "CALL" or "PUT", so
 * this leaves those words out and says what the print was: who paid which
 * side, and which way the bet leans. Both the toast and the row repeat it on
 * every announcement or row, so each stays well under 60 characters.
 */
export const SIDE_SR_TEXT: Record<'C' | 'P', string> = {
  C: 'buyers paid the ask for upside calls, bullish',
  P: 'buyers paid the ask for downside puts, bearish',
};
