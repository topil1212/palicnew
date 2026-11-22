// Market regime from Palic's own observations. Pure.
//
// Inputs are aggregates the bot already sees — the tokens that reached it in the
// last window and the SOL price it sampled — so no extra API is needed. With too
// few observations the regime is 'unknown': the bot does not guess.

import { num, median, round } from './util.js';

export const MIN_REGIME_SAMPLES = 8;

// One snapshot from a set of recent candidates (each the usual candidate object).
export function summarizeMarket(candidates = [], { solUsd = null, nowMs = Date.now() } = {}) {
  const c5 = [], c1 = [], liq = [], liqChange = [], nb = [];
  for (const candidate of candidates) {
    const jup = candidate?.jupiterAsset || {};
    const change5m = num(jup.stats5m?.priceChange);
    const change1h = num(jup.stats1h?.priceChange);
    const traders = num(jup.stats5m?.numTraders);
    const net = num(jup.stats5m?.numNetBuyers);
    if (change5m != null) c5.push(change5m);
    if (change1h != null) c1.push(change1h);
    const l = num(candidate?.metrics?.liquidityUsd);
    if (l != null && l > 0) liq.push(l);
    const lc = num(jup.stats5m?.liquidityChange);
    if (lc != null) liqChange.push(lc);
    if (traders && net != null) nb.push(net / traders);
  }
  const share = (xs, test) => (xs.length ? xs.filter(test).length / xs.length : null);
  return {
    atMs: nowMs,
    sampleSize: candidates.length,
    solUsd: num(solUsd),
    medianChange5m: round(median(c5), 2),
    medianChange1h: round(median(c1), 2),
    shareRising5m: round(share(c5, v => v > 0), 3),
    shareNetBuying: round(share(nb, v => v > 0), 3),
    medianLiquidityUsd: round(median(liq), 0),
    medianLiquidityChange5m: round(median(liqChange), 2),
    dispersion5m: c5.length >= 4 ? round(median(c5.map(v => Math.abs(v - median(c5)))), 2) : null,
  };
}

/**
 * @param {object} snapshot  latest summarizeMarket() result
 * @param {Array}  history   earlier snapshots, oldest first (for SOL trend / contraction)
 */
export function classifyRegime(snapshot, history = []) {
  const flags = [];
  if (!snapshot || (snapshot.sampleSize ?? 0) < MIN_REGIME_SAMPLES) {
    return { regime: 'unknown', score: null, flags: ['insufficient_samples'], basis: snapshot || null };
  }
  const rising = snapshot.shareRising5m;
  const buying = snapshot.shareNetBuying;
  const m1h = snapshot.medianChange1h;

  // SOL move across the stored history (when price samples exist).
  const priced = [...history, snapshot].filter(s => s && s.solUsd != null && s.solUsd > 0);
  let solChangePct = null;
  if (priced.length >= 2) solChangePct = (priced[priced.length - 1].solUsd / priced[0].solUsd - 1) * 100;

  if (snapshot.dispersion5m != null && snapshot.dispersion5m > 40) flags.push('high_volatility');
  if (buying != null && buying < 0.35) flags.push('market_wide_sell_pressure');
  if (snapshot.medianLiquidityChange5m != null && snapshot.medianLiquidityChange5m < -5) flags.push('liquidity_contraction');
  if (snapshot.medianLiquidityUsd != null && snapshot.medianLiquidityUsd < 5000) flags.push('low_liquidity');
  if (solChangePct != null && solChangePct < -3) flags.push('sol_falling');
  if (rising != null && rising > 0.7 && m1h != null && m1h > 50) flags.push('momentum_expansion');

  // Breadth score 0-100: how much of the observed market is rising and being bought.
  const parts = [rising, buying].filter(v => v != null);
  if (!parts.length) return { regime: 'unknown', score: null, flags: [...flags, 'no_breadth_data'], basis: snapshot };
  let score = (parts.reduce((a, b) => a + b, 0) / parts.length) * 100;
  if (flags.includes('liquidity_contraction')) score -= 10;
  if (flags.includes('sol_falling')) score -= 10;
  score = Math.max(0, Math.min(100, score));

  let regime = 'neutral';
  if (score >= 60) regime = 'risk_on';
  else if (score <= 40) regime = 'risk_off';
  return { regime, score: round(score, 1), flags, solChangePct: round(solChangePct, 2), basis: snapshot };
}
