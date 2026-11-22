// Token lifecycle stage. Pure, rule-based, descriptive.
//
// It labels where a token is in its life from data the candidate already carries.
// The label is recorded with every candidate so outcomes can later be compared per
// stage; it does not gate anything by itself.

import { num } from './util.js';

export const STAGES = Object.freeze([
  'pre_graduation', 'fresh_launch', 'early_momentum', 'acceleration', 'extended',
  'consolidation', 'distribution', 'declining', 'unknown',
]);

export function tokenAgeMs(candidate, nowMs) {
  const created = candidate?.jupiterAsset?.createdAt || candidate?.jupiterAsset?.firstPool?.createdAt;
  const fromIso = created ? Date.parse(created) : NaN;
  if (Number.isFinite(fromIso)) return Math.max(0, nowMs - fromIso);
  const ts = num(candidate?.trenchesEntry?.created_timestamp);
  if (ts != null && ts > 0) return Math.max(0, nowMs - (ts > 1e12 ? ts : ts * 1000));
  return null;
}

export function classifyLifecycle(candidate, nowMs = Date.now()) {
  const jup = candidate?.jupiterAsset || {};
  const s5 = jup.stats5m || {};
  const s1 = jup.stats1h || {};
  const ageMs = tokenAgeMs(candidate, nowMs);
  const change5m = num(s5.priceChange);
  const change1h = num(s1.priceChange);
  const liqChange5m = num(s5.liquidityChange);
  const traders5m = num(s5.numTraders);
  const netBuyers5m = num(s5.numNetBuyers);
  const netBuyerRatio = traders5m ? (netBuyers5m ?? 0) / traders5m : null;
  const athDistance = num(candidate?.chart?.distanceFromAthPercent);
  const bondingPct = num(jup.bondingCurve) ?? num(candidate?.metrics?.pregradRssrPctToGrad);
  const route = String(candidate?.signals?.route || '');
  const evidence = { ageMin: ageMs == null ? null : Math.round(ageMs / 60000), change5m, change1h, netBuyerRatio, liqChange5m, athDistance, bondingPct };

  const done = (stage, why) => ({ stage, why, evidence });

  if (route.includes('pregrad') && (bondingPct == null || bondingPct < 100)) {
    return done('pre_graduation', 'still on the bonding curve');
  }
  if (change5m == null && change1h == null) return done('unknown', 'no price-change data');

  // Falling with sellers in control.
  if (change1h != null && change1h < -30 && (change5m ?? 0) <= 0) return done('declining', `1h ${change1h.toFixed(0)}%, 5m not recovering`);
  if (liqChange5m != null && liqChange5m < -20) return done('declining', `liquidity ${liqChange5m.toFixed(0)}% in 5m`);

  // Up over the hour but sellers now dominate: holders are distributing.
  if (change1h != null && change1h > 20 && netBuyerRatio != null && netBuyerRatio < 0 && (change5m ?? 0) < 0) {
    return done('distribution', `1h +${change1h.toFixed(0)}% but net sellers in the last 5m`);
  }

  if (ageMs != null && ageMs < 10 * 60_000) return done('fresh_launch', 'under 10 minutes old');

  // Most of the move already happened.
  if (change1h != null && change1h > 300) return done('extended', `1h +${change1h.toFixed(0)}%`);
  if (athDistance != null && athDistance > -5 && change1h != null && change1h > 150) return done('extended', 'at the high after a large 1h move');

  if (change5m != null && change5m > 25 && netBuyerRatio != null && netBuyerRatio > 0.2) {
    return done('acceleration', `5m +${change5m.toFixed(0)}% with net buyers`);
  }
  if (change5m != null && change5m > 5 && (netBuyerRatio == null || netBuyerRatio > 0)) {
    return done('early_momentum', `5m +${change5m.toFixed(0)}%`);
  }
  if (change5m != null && Math.abs(change5m) <= 5) return done('consolidation', '5m roughly flat');
  if (change5m != null && change5m < -5) return done('declining', `5m ${change5m.toFixed(0)}%`);
  return done('unknown', 'no rule matched');
}
