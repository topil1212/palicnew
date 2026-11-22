// Penghubung antara token Jupiter dan scorecard (src/intel). Scorecard sendiri murni dan tidak tahu soal bot ini.
import { scoreCandidate, explainScorecard } from './intel/scorecard.js';
import { classifyLifecycle } from './intel/lifecycle.js';
import { summarizeMarket, classifyRegime } from './intel/regime.js';

export function candidateFromToken(token, evaluation = null) {
  return {
    jupiterAsset: token,
    metrics: { priceUsd: token.usdPrice, marketCapUsd: token.mcap, liquidityUsd: token.liquidity, holderCount: token.holderCount },
    signals: { route: 'p6' },
    chart: evaluation && Number.isFinite(evaluation.dropPct) ? { distanceFromAthPercent: -evaluation.dropPct } : null,
  };
}

export function scoreToken(token, { evaluation = null, regime = null, sizeSol = null, solUsd = null, nowMs = Date.now() } = {}) {
  const candidate = candidateFromToken(token, evaluation);
  const lifecycle = classifyLifecycle(candidate, nowMs);
  const card = scoreCandidate(candidate, { nowMs, sizeSol, solUsd, regime, lifecycle });
  return {
    overall: card.overall,
    completeness: card.completeness.percent,
    lifecycle: lifecycle.stage,
    flags: card.flags,
    hardGates: card.hardGates,
    lines: explainScorecard(card, 12),
  };
}

export function marketRegime(tokens, history = [], { solUsd = null, nowMs = Date.now() } = {}) {
  const snapshot = summarizeMarket(tokens.map((t) => candidateFromToken(t)), { solUsd, nowMs });
  return { snapshot, regime: classifyRegime(snapshot, history) };
}
