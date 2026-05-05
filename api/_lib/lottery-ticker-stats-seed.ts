/**
 * Initial seed for the `lottery_ticker_stats` table (migration #126).
 *
 * Source: ml/data/lottery_ticker_stats.json — produced by
 * ml/src/lottery_scoring.py on the 21-day historical window of
 * lottery_finder_fires. Embedded inline so the migration is
 * self-contained (no filesystem read at deploy time).
 *
 * `tier`: 'reliable' (CI width <10pp), 'uncertain' (>15pp), or '' in
 * the middle band. Drives the ✓ / ⚠️ ticker reliability indicator.
 *
 * Ongoing refresh: a future weekly cron will recompute these from
 * lottery_finder_fires; for now the seed values stand until that
 * cron lands.
 */
export interface LotteryTickerStatSeed {
  ticker: string;
  n_fires: number;
  high_peak_rate: number;
  ci_lower: number;
  ci_upper: number;
  ci_width: number;
  tier: 'reliable' | 'uncertain' | '';
}

export const LOTTERY_TICKER_STATS_SEED: readonly LotteryTickerStatSeed[] = [
  { ticker: 'TSLA', n_fires: 8147, high_peak_rate: 42.3714250644, ci_lower: 41.3022549195, ci_upper: 43.4477858428, ci_width: 2.1455309233, tier: 'reliable' },
  { ticker: 'META', n_fires: 5658, high_peak_rate: 24.8851184164, ci_lower: 23.7758643467, ci_upper: 26.0284524878, ci_width: 2.2525881411, tier: 'reliable' },
  { ticker: 'NVDA', n_fires: 3974, high_peak_rate: 36.4871665828, ci_lower: 35.0041813334, ci_upper: 37.996250908, ci_width: 2.9920695746, tier: 'reliable' },
  { ticker: 'AMD', n_fires: 3728, high_peak_rate: 32.8594420601, ci_lower: 31.3699973443, ci_upper: 34.3841748492, ci_width: 3.0141775048, tier: 'reliable' },
  { ticker: 'MU', n_fires: 3708, high_peak_rate: 26.9687162891, ci_lower: 25.564649495, ci_upper: 28.4204541537, ci_width: 2.8558046588, tier: 'reliable' },
  { ticker: 'AMZN', n_fires: 2816, high_peak_rate: 37.3934659091, ci_lower: 35.624713504, ci_upper: 39.1965659768, ci_width: 3.5718524728, tier: 'reliable' },
  { ticker: 'MSFT', n_fires: 2753, high_peak_rate: 31.1660007265, ci_lower: 29.4630882038, ci_upper: 32.9214008758, ci_width: 3.4583126719, tier: 'reliable' },
  { ticker: 'QQQ', n_fires: 2748, high_peak_rate: 31.9868995633, ci_lower: 30.269179303, ci_upper: 33.7549109357, ci_width: 3.4857316327, tier: 'reliable' },
  { ticker: 'SPY', n_fires: 2515, high_peak_rate: 21.9085487078, ci_lower: 20.3355113684, ci_upper: 23.5672700055, ci_width: 3.2317586371, tier: 'reliable' },
  { ticker: 'AVGO', n_fires: 1974, high_peak_rate: 20.6180344478, ci_lower: 18.891247733, ci_upper: 22.4589552964, ci_width: 3.5677075634, tier: 'reliable' },
  { ticker: 'PLTR', n_fires: 1785, high_peak_rate: 25.2100840336, ci_lower: 23.2504166516, ci_upper: 27.276221937, ci_width: 4.0258052854, tier: 'reliable' },
  { ticker: 'SLV', n_fires: 1561, high_peak_rate: 45.4196028187, ci_lower: 42.9639135307, ci_upper: 47.8977805282, ci_width: 4.9338669975, tier: 'reliable' },
  { ticker: 'SNDK', n_fires: 1541, high_peak_rate: 64.892926671, ci_lower: 62.4754673523, ci_upper: 67.2363194061, ci_width: 4.7608520537, tier: 'reliable' },
  { ticker: 'INTC', n_fires: 1437, high_peak_rate: 15.1009046625, ci_lower: 13.3427969494, ci_upper: 17.0451028532, ci_width: 3.7023059039, tier: 'reliable' },
  { ticker: 'GOOGL', n_fires: 1367, high_peak_rate: 26.9934162399, ci_lower: 24.7070212099, ci_upper: 29.4087522844, ci_width: 4.7017310745, tier: 'reliable' },
  { ticker: 'HOOD', n_fires: 1244, high_peak_rate: 14.9517684887, ci_lower: 13.0781728745, ci_upper: 17.0411548786, ci_width: 3.9629820041, tier: 'reliable' },
  { ticker: 'MSTR', n_fires: 1236, high_peak_rate: 27.427184466, ci_lower: 25.0127614815, ci_upper: 29.9814842723, ci_width: 4.9687227908, tier: 'reliable' },
  { ticker: 'ORCL', n_fires: 1089, high_peak_rate: 16.1616161616, ci_lower: 14.0949278505, ci_upper: 18.4661958101, ci_width: 4.3712679596, tier: 'reliable' },
  { ticker: 'GOOG', n_fires: 998, high_peak_rate: 31.5631262525, ci_lower: 28.754999547, ci_upper: 34.5126415793, ci_width: 5.7576420323, tier: 'reliable' },
  { ticker: 'USO', n_fires: 964, high_peak_rate: 47.1991701245, ci_lower: 44.0651739328, ci_upper: 50.3553998597, ci_width: 6.2902259269, tier: 'reliable' },
  { ticker: 'MRVL', n_fires: 799, high_peak_rate: 30.5381727159, ci_lower: 27.4440652498, ci_upper: 33.8185231998, ci_width: 6.37445795, tier: 'reliable' },
  { ticker: 'COIN', n_fires: 765, high_peak_rate: 26.5359477124, ci_lower: 23.5300499758, ci_upper: 29.7763182122, ci_width: 6.2462682365, tier: 'reliable' },
  { ticker: 'AAPL', n_fires: 631, high_peak_rate: 18.2250396197, ci_lower: 15.4081313379, ci_upper: 21.4264917907, ci_width: 6.0183604528, tier: 'reliable' },
  { ticker: 'IWM', n_fires: 595, high_peak_rate: 0.1680672269, ci_lower: 0.0296741557, ci_upper: 0.9457858321, ci_width: 0.9161116764, tier: 'reliable' },
  { ticker: 'SOXL', n_fires: 501, high_peak_rate: 42.9141716567, ci_lower: 38.6502253312, ci_upper: 47.285953491, ci_width: 8.6357281599, tier: 'reliable' },
  { ticker: 'TQQQ', n_fires: 389, high_peak_rate: 40.3598971722, ci_lower: 35.6016635597, ci_upper: 45.3066651526, ci_width: 9.7050015928, tier: 'reliable' },
  { ticker: 'RUTW', n_fires: 307, high_peak_rate: 57.003257329, ci_lower: 51.4124367265, ci_upper: 62.4209818153, ci_width: 11.0085450887, tier: '' },
  { ticker: 'TSM', n_fires: 277, high_peak_rate: 60.2888086643, ci_lower: 54.423758572, ci_upper: 65.8723900947, ci_width: 11.4486315227, tier: '' },
  { ticker: 'RDDT', n_fires: 228, high_peak_rate: 64.0350877193, ci_lower: 57.6208263788, ci_upper: 69.9842449167, ci_width: 12.363418538, tier: '' },
  { ticker: 'SMH', n_fires: 221, high_peak_rate: 35.7466063348, ci_lower: 29.7210564314, ci_upper: 42.2592000878, ci_width: 12.5381436564, tier: '' },
  { ticker: 'RKLB', n_fires: 217, high_peak_rate: 43.3179723502, ci_lower: 36.8978852647, ci_upper: 49.970522436, ci_width: 13.0726371713, tier: '' },
  { ticker: 'XOM', n_fires: 185, high_peak_rate: 65.4054054054, ci_lower: 58.3004079488, ci_upper: 71.8836418652, ci_width: 13.5832339164, tier: '' },
  { ticker: 'SNOW', n_fires: 181, high_peak_rate: 56.3535911602, ci_lower: 49.0707006004, ci_upper: 63.3723953082, ci_width: 14.3016947078, tier: '' },
  { ticker: 'TSLL', n_fires: 169, high_peak_rate: 52.0710059172, ci_lower: 44.5771503954, ci_upper: 59.4728038503, ci_width: 14.8956534549, tier: '' },
  { ticker: 'WDC', n_fires: 167, high_peak_rate: 47.9041916168, ci_lower: 40.4601720548, ci_upper: 55.442461856, ci_width: 14.9822898011, tier: '' },
  { ticker: 'SQQQ', n_fires: 166, high_peak_rate: 35.5421686747, ci_lower: 28.6633497906, ci_upper: 43.0749994127, ci_width: 14.4116496221, tier: '' },
  { ticker: 'RBLX', n_fires: 134, high_peak_rate: 46.2686567164, ci_lower: 38.0483132513, ci_upper: 54.6969753683, ci_width: 16.648662117, tier: 'uncertain' },
  { ticker: 'SOXS', n_fires: 133, high_peak_rate: 42.1052631579, ci_lower: 34.05160522, ci_upper: 50.6021684382, ci_width: 16.5505632182, tier: 'uncertain' },
  { ticker: 'WMT', n_fires: 114, high_peak_rate: 65.7894736842, ci_lower: 56.6937223335, ci_upper: 73.8557976404, ci_width: 17.1620753069, tier: 'uncertain' },
  { ticker: 'SMCI', n_fires: 110, high_peak_rate: 46.3636363636, ci_lower: 37.3250810791, ci_upper: 55.6476020867, ci_width: 18.3225210076, tier: 'uncertain' },
  { ticker: 'UNH', n_fires: 108, high_peak_rate: 42.5925925926, ci_lower: 33.679220438, ci_upper: 52.0148145213, ci_width: 18.3355940833, tier: 'uncertain' },
  { ticker: 'SOFI', n_fires: 103, high_peak_rate: 59.2233009709, ci_lower: 49.567612544, ci_upper: 68.2157462848, ci_width: 18.6481337409, tier: 'uncertain' },
  { ticker: 'SOUN', n_fires: 88, high_peak_rate: 60.2272727273, ci_lower: 49.7807300429, ci_upper: 69.8182617754, ci_width: 20.0375317325, tier: 'uncertain' },
  { ticker: 'RIVN', n_fires: 84, high_peak_rate: 50.0, ci_lower: 39.5439337685, ci_upper: 60.4560662315, ci_width: 20.9121324629, tier: 'uncertain' },
  { ticker: 'STX', n_fires: 75, high_peak_rate: 57.3333333333, ci_lower: 46.0527923293, ci_upper: 67.899257981, ci_width: 21.8464656517, tier: 'uncertain' },
  { ticker: 'RIOT', n_fires: 74, high_peak_rate: 44.5945945946, ci_lower: 33.8158223285, ci_upper: 55.9068779893, ci_width: 22.0910556609, tier: 'uncertain' },
  { ticker: 'TEAM', n_fires: 71, high_peak_rate: 67.6056338028, ci_lower: 56.0611570558, ci_upper: 77.3427882894, ci_width: 21.2816312335, tier: 'uncertain' },
  { ticker: 'WULF', n_fires: 70, high_peak_rate: 40.0, ci_lower: 29.3342577256, ci_upper: 51.7062035226, ci_width: 22.3719457971, tier: 'uncertain' },
  { ticker: 'USAR', n_fires: 63, high_peak_rate: 71.4285714286, ci_lower: 59.2972834326, ci_upper: 81.0968080136, ci_width: 21.799524581, tier: 'uncertain' },
  { ticker: 'TNA', n_fires: 55, high_peak_rate: 49.0909090909, ci_lower: 36.376777849, ci_upper: 61.923740153, ci_width: 25.546962304, tier: 'uncertain' },
  { ticker: 'UBER', n_fires: 43, high_peak_rate: 46.511627907, ci_lower: 32.5110577041, ci_upper: 61.0843595277, ci_width: 28.5733018236, tier: 'uncertain' },
];
