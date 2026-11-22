// Explainable candidate scorecard. Pure — no DB, no network.
//
// Twelve independent components, each scored 0-100 from data the candidate
// already carries, each reporting what it used and what was missing.
//
// Design rules (and how they are met):
//   * Missing is not negative: a component with no inputs returns score=null and
//     is left out of the overall score instead of being counted as 0 (or, as the
//     old soft score did for bundler rate, as a bonus).
//   * No double counting: every raw input feeds exactly one component. Momentum
//     uses order flow only; price extension belongs to entry timing; liquidity
//     depth belongs to liquidity while trade-size impact belongs to exit feasibility.
//   * Hard gates are separate from the score and cannot be outvoted by it.
//   * Weights are configurable and equal by default. Equal weights make no claim
//     about which component matters; `palic intel` measures that against outcomes.
//
// The anchor points inside scale() calls are v0 priors, not fitted values. Until
// outcome data validates them the scorecard runs in shadow mode (recorded, not
// enforced) — see docs/INTELLIGENCE.md.

import { num, scale, ratio, blend, round } from './util.js';

export const SCORECARD_VERSION = 'scorecard-0.1';

export const COMPONENTS = Object.freeze([
  'liquidity', 'momentum', 'volumeQuality', 'holderQuality', 'smartMoney', 'developerRisk',
  'contractSafety', 'narrative', 'entryTiming', 'exitFeasibility', 'marketRegime', 'dataReliability',
]);

export const DEFAULT_WEIGHTS = Object.freeze(Object.fromEntries(COMPONENTS.map(name => [name, 1])));

const LIFECYCLE_TIMING = Object.freeze({
  early_momentum: 80, acceleration: 65, consolidation: 55, fresh_launch: 50,
  pre_graduation: 50, extended: 20, distribution: 10, declining: 5,
});

function log10(value) {
  return value != null && value > 0 ? Math.log10(value) : null;
}

function result(parts, reasons, inputs, { min = 1, flags = [] } = {}) {
  const total = parts.length;
  const present = parts.filter(p => p.value != null).length;
  const score = blend(parts, min);
  return {
    score: round(score, 1),
    completeness: total ? round(present / total, 2) : 0,
    reasons: reasons.filter(Boolean),
    flags,
    inputs,
  };
}

function usd(value) {
  if (value == null) return '?';
  return value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(0)}`;
}

function pct(value, digits = 0) {
  return value == null ? '?' : `${value.toFixed(digits)}%`;
}

function facts(candidate) {
  const jup = candidate?.jupiterAsset || {};
  const s5 = jup.stats5m || {};
  const s1 = jup.stats1h || {};
  const audit = jup.audit || {};
  const metrics = candidate?.metrics || {};
  const traders5m = num(s5.numTraders);
  const buy5 = num(s5.buyVolume), sell5 = num(s5.sellVolume);
  return {
    jup, s5, s1, audit, metrics,
    price: num(metrics.priceUsd),
    mcap: num(metrics.marketCapUsd),
    liquidity: num(metrics.liquidityUsd),
    holderCount: num(metrics.holderCount),
    change5m: num(s5.priceChange),
    change1h: num(s1.priceChange),
    liqChange5m: num(s5.liquidityChange),
    holderChange5m: num(s5.holderChange),
    buy5, sell5,
    netBuyerRatio5m: traders5m ? ratio(num(s5.numNetBuyers), traders5m) : null,
    buyShare5m: buy5 != null && sell5 != null && buy5 + sell5 > 0 ? buy5 / (buy5 + sell5) : null,
    swapsPerTrader5m: traders5m ? ratio((num(s5.numBuys) ?? 0) + (num(s5.numSells) ?? 0), traders5m) : null,
    organicShare: ratio(num(s1.buyOrganicVolume) ?? num(s5.buyOrganicVolume), num(s1.buyVolume) ?? buy5),
  };
}

// ── components ──────────────────────────────────────────────────────────────

function liquidityScore(f) {
  const liq = f.liquidity != null && f.liquidity > 0 ? f.liquidity : null;
  const liqToMcap = liq != null && f.mcap ? liq / f.mcap : null;
  const flags = [];
  if (f.liqChange5m != null && f.liqChange5m < -20) flags.push('liquidity_draining');
  return result([
    { value: scale(log10(liq), log10(3000), log10(100000)), weight: 2 },
    { value: scale(liqToMcap, 0.03, 0.30) },
    { value: scale(f.liqChange5m, -20, 20) },
  ], [
    liq != null ? `liquidity ${usd(liq)}` : 'liquidity unknown',
    liqToMcap != null ? `${pct(liqToMcap * 100)} of mcap` : null,
    f.liqChange5m != null ? `5m change ${pct(f.liqChange5m)}` : null,
  ], { liquidityUsd: liq, liqToMcap: round(liqToMcap, 3), liqChange5m: f.liqChange5m }, { flags });
}

function momentumScore(f) {
  const flags = [];
  if (f.change5m != null && f.change5m > 10 && f.netBuyerRatio5m != null && f.netBuyerRatio5m < 0) flags.push('momentum_divergence');
  return result([
    { value: scale(f.netBuyerRatio5m, -0.2, 0.5), weight: 2 },
    { value: scale(f.buyShare5m, 0.40, 0.65) },
    { value: scale(f.holderChange5m, 0, 20) },
  ], [
    f.netBuyerRatio5m != null ? `net buyers ${pct(f.netBuyerRatio5m * 100)} of traders (5m)` : 'no order-flow data',
    f.buyShare5m != null ? `buy share ${pct(f.buyShare5m * 100)}` : null,
    f.holderChange5m != null ? `holders ${f.holderChange5m >= 0 ? '+' : ''}${pct(f.holderChange5m)} (5m)` : null,
    flags.includes('momentum_divergence') ? 'price up while traders net sell' : null,
  ], { netBuyerRatio5m: round(f.netBuyerRatio5m, 3), buyShare5m: round(f.buyShare5m, 3), holderChange5m: f.holderChange5m }, { flags });
}

function volumeQualityScore(f, candidate) {
  const flags = [];
  const wash = candidate?.trending?.is_wash_trading;
  if (wash === true || wash === 1) flags.push('wash_trading_flag');
  const organic = num(f.jup.organicScore);
  const parts = [
    { value: scale(f.organicShare, 0, 0.5) },
    { value: scale(f.swapsPerTrader5m, 6, 1.5) },
    { value: f.jup.organicScore === undefined ? null : scale(organic, 0, 80) },
  ];
  const out = result(parts, [
    f.organicShare != null ? `organic buy volume ${pct(f.organicShare * 100)}` : null,
    f.swapsPerTrader5m != null ? `${f.swapsPerTrader5m.toFixed(1)} swaps per trader (5m)` : null,
    organic != null ? `organic score ${organic}` : null,
    flags.length ? 'flagged as wash trading' : null,
  ], { organicShare: round(f.organicShare, 3), swapsPerTrader5m: round(f.swapsPerTrader5m, 2), organicScore: organic }, { flags });
  if (flags.length && out.score != null) out.score = Math.min(out.score, 10);
  return out;
}

function holderQualityScore(f) {
  const top10 = num(f.audit.topHoldersPercentage);
  const botPct = num(f.audit.botHoldersPercentage);
  const holders = f.holderCount != null && f.holderCount > 0 ? f.holderCount : null;
  return result([
    { value: scale(log10(holders), log10(30), log10(2000)) },
    { value: scale(top10, 60, 15) },
    { value: scale(botPct, 60, 10) },
  ], [
    holders != null ? `${holders} holders` : 'holder count unknown',
    top10 != null ? `top holders ${pct(top10)}` : null,
    botPct != null ? `bots ${pct(botPct)}` : null,
  ], { holderCount: holders, topHoldersPercentage: top10, botHoldersPercentage: botPct });
}

function smartMoneyScore(candidate) {
  const smart = candidate?.trending ? num(candidate.trending.smart_degen_count) : null;
  const exposure = candidate?.savedWalletExposure;
  const savedChecked = num(exposure?.checked);
  const savedHolding = savedChecked ? num(exposure?.holderCount) : null;   // 0 wallets checked = no evidence
  return result([
    { value: scale(smart, 0, 10) },
    { value: savedHolding == null ? null : scale(savedHolding, 0, Math.min(3, savedChecked)) },
  ], [
    smart != null ? `${smart} smart wallets (trending feed)` : null,
    savedHolding != null ? `${savedHolding}/${savedChecked} saved wallets holding` : null,
    smart == null && savedHolding == null ? 'no smart-money evidence available' : null,
  ], { smartDegenCount: smart, savedWalletsHolding: savedHolding, savedWalletsChecked: savedChecked });
}

function developerRiskScore(f) {
  const devBalance = num(f.audit.devBalancePercentage);
  // devMigrations / devMints are recorded but not scored: the codebase disagreed
  // with itself about their direction (soft score penalised them, the LLM prompt
  // called them positive). They stay as inputs until outcome data settles it.
  return result([
    { value: scale(devBalance, 20, 0) },
  ], [
    devBalance != null ? `dev holds ${pct(devBalance, 1)}` : 'dev holdings unknown',
  ], { devBalancePercentage: devBalance, devMigrations: num(f.audit.devMigrations), devMints: num(f.audit.devMints) });
}

function contractSafetyScore(f) {
  const mint = f.audit.mintAuthorityDisabled;
  const freeze = f.audit.freezeAuthorityDisabled;
  const known = v => v === true || v === false;
  const token2022 = Array.isArray(f.jup.tags) && f.jup.tags.includes('token-2022');
  return result([
    { value: known(mint) ? (mint ? 100 : 0) : null },
    { value: known(freeze) ? (freeze ? 100 : 0) : null },
  ], [
    known(mint) ? `mint authority ${mint ? 'disabled' : 'ENABLED'}` : 'mint authority unknown',
    known(freeze) ? `freeze authority ${freeze ? 'disabled' : 'ENABLED'}` : 'freeze authority unknown',
    token2022 ? 'token-2022 (extensions possible)' : null,
  ], { mintAuthorityDisabled: known(mint) ? mint : null, freezeAuthorityDisabled: known(freeze) ? freeze : null, token2022 });
}

function narrativeScore(candidate) {
  const token = candidate?.token || {};
  const hasAsset = candidate?.jupiterAsset != null || candidate?.gmgn != null;
  const socials = ['twitter', 'website', 'telegram'].filter(key => String(token[key] || '').trim()).length;
  const likes = num(candidate?.twitterNarrative?.metrics?.likes);
  return result([
    { value: hasAsset ? (socials / 3) * 100 : null },
    { value: likes == null ? null : scale(Math.log10(likes + 1), 0, 3) },
  ], [
    hasAsset ? `${socials}/3 social links` : 'social links unknown',
    likes != null ? `tweet ${likes} likes` : null,
  ], { socialLinks: hasAsset ? socials : null, tweetLikes: likes });
}

function entryTimingScore(f, ctx) {
  const stage = ctx.lifecycle?.stage;
  const stageScore = stage && stage in LIFECYCLE_TIMING ? LIFECYCLE_TIMING[stage] : null;
  const flags = [];
  if (f.change5m != null && f.change5m > 150) flags.push('late_entry_risk');
  if (stage === 'distribution' || stage === 'declining') flags.push(`lifecycle_${stage}`);
  return result([
    { value: stageScore, weight: 2 },
    { value: scale(f.change5m, 150, 20) },
    { value: scale(f.change1h, 600, 50) },
  ], [
    stage ? `lifecycle ${stage}` : 'lifecycle unknown',
    f.change5m != null ? `5m ${f.change5m >= 0 ? '+' : ''}${pct(f.change5m)}` : null,
    f.change1h != null ? `1h ${f.change1h >= 0 ? '+' : ''}${pct(f.change1h)}` : null,
  ], { lifecycle: stage || null, change5m: f.change5m, change1h: f.change1h }, { flags });
}

function exitFeasibilityScore(f, ctx) {
  const sizeUsd = ctx.sizeSol != null && ctx.solUsd != null ? ctx.sizeSol * ctx.solUsd : null;
  const liq = f.liquidity != null && f.liquidity > 0 ? f.liquidity : null;
  // Constant-product estimate: selling value s into a pool side R moves price ~ s/(R+s).
  const impactPct = sizeUsd != null && liq != null ? (sizeUsd / (liq / 2 + sizeUsd)) * 100 : null;
  const sellTurnover = liq != null ? ratio(f.sell5, liq) : null;
  const flags = [];
  if (impactPct != null && impactPct > 5) flags.push('high_exit_impact');
  return result([
    { value: scale(impactPct, 8, 0.5), weight: 2 },
    { value: scale(sellTurnover, 1.5, 0.1) },
  ], [
    impactPct != null ? `est. exit impact ${pct(impactPct, 1)} for ${usd(sizeUsd)}` : 'exit impact unknown (need size, SOL price, liquidity)',
    sellTurnover != null ? `5m sells = ${pct(sellTurnover * 100)} of liquidity` : null,
  ], { estExitImpactPct: round(impactPct, 2), sellTurnover5m: round(sellTurnover, 3), sizeUsd: round(sizeUsd, 2) }, { flags });
}

function marketRegimeScore(ctx) {
  const regime = ctx.regime || {};
  const score = num(regime.score);
  return result([{ value: score }], [
    regime.regime ? `regime ${regime.regime}` : 'regime unknown',
    ...(regime.flags || []).filter(flag => flag !== 'insufficient_samples'),
  ], { regime: regime.regime || 'unknown', flags: regime.flags || [] });
}

function relDiff(a, b) {
  if (a == null || b == null || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

function dataReliabilityScore(candidate, f, ctx, completenessPct) {
  const updatedAt = Date.parse(f.jup.updatedAt || '');
  const ageSec = Number.isFinite(updatedAt) ? Math.max(0, (ctx.nowMs - updatedAt) / 1000) : null;
  const gmgn = candidate?.gmgn;
  const disagreements = [];
  const liqDiff = gmgn ? relDiff(num(gmgn.liquidity), num(f.jup.liquidity)) : null;
  const holderDiff = gmgn ? relDiff(num(gmgn.holder_count), num(f.jup.holderCount)) : null;
  if (liqDiff != null && liqDiff > 0.25) disagreements.push(`liquidity differs ${pct(liqDiff * 100)} between GMGN and Jupiter`);
  if (holderDiff != null && holderDiff > 0.25) disagreements.push(`holders differ ${pct(holderDiff * 100)} between GMGN and Jupiter`);
  const worst = [liqDiff, holderDiff].filter(v => v != null);
  const agreement = worst.length ? scale(Math.max(...worst), 0.5, 0.05) : null;
  return result([
    { value: completenessPct, weight: 2 },
    { value: scale(ageSec, 120, 5) },
    { value: agreement },
  ], [
    `data completeness ${pct(completenessPct)}`,
    ageSec != null ? `asset data ${Math.round(ageSec)}s old` : 'asset freshness unknown',
    worst.length ? null : 'single source — no cross-check possible',
    ...disagreements,
  ], { completenessPct, assetAgeSec: round(ageSec, 0), sourceDisagreement: round(worst.length ? Math.max(...worst) : null, 3) },
  { flags: disagreements.length ? ['source_disagreement'] : [] });
}

// ── completeness & hard gates ───────────────────────────────────────────────

const FIELD_TIERS = [
  // [label, weight, getter]
  ['price', 3, (c, f) => f.price != null && f.price > 0],
  ['marketCap', 3, (c, f) => f.mcap != null && f.mcap > 0],
  ['liquidity', 3, (c, f) => f.liquidity != null && f.liquidity > 0],
  ['decimals', 3, c => Number.isInteger(Number(c?.jupiterAsset?.decimals ?? c?.metrics?.decimals))],
  ['holderCount', 2, (c, f) => f.holderCount != null && f.holderCount > 0],
  ['orderFlow5m', 2, (c, f) => f.netBuyerRatio5m != null],
  ['priceChange5m', 2, (c, f) => f.change5m != null],
  ['priceChange1h', 2, (c, f) => f.change1h != null],
  ['audit', 2, (c, f) => f.audit.mintAuthorityDisabled === true || f.audit.mintAuthorityDisabled === false],
  ['topHolders', 2, (c, f) => num(f.audit.topHoldersPercentage) != null],
  ['gmgn', 1, c => c?.gmgn != null],
  ['chart', 1, c => c?.chart != null],
  ['smartMoney', 1, c => c?.trending != null || Number(c?.savedWalletExposure?.checked) > 0],
  ['narrative', 1, c => c?.twitterNarrative != null],
];

export function dataCompleteness(candidate) {
  const f = facts(candidate);
  let total = 0, have = 0;
  const missing = [];
  for (const [label, weight, test] of FIELD_TIERS) {
    total += weight;
    if (test(candidate, f)) have += weight;
    else missing.push(label);
  }
  return { percent: round((have / total) * 100, 0), missing, criticalMissing: missing.filter(m => ['price', 'marketCap', 'liquidity', 'decimals'].includes(m)) };
}

// Deterministic rejections. These never depend on a score, an ML output or an LLM.
export function hardGates(candidate) {
  const f = facts(candidate);
  const completeness = dataCompleteness(candidate);
  const failures = [];
  for (const field of completeness.criticalMissing) failures.push({ gate: 'critical_data_missing', detail: `${field} is missing` });
  if (f.audit.mintAuthorityDisabled === false) failures.push({ gate: 'mint_authority_enabled', detail: 'supply can still be minted' });
  if (f.audit.freezeAuthorityDisabled === false) failures.push({ gate: 'freeze_authority_enabled', detail: 'token accounts can be frozen' });
  return { passed: failures.length === 0, failures };
}

// ── assembly ────────────────────────────────────────────────────────────────

/**
 * @param {object} candidate
 * @param {object} ctx  { nowMs, sizeSol, solUsd, regime, lifecycle, weights }
 */
export function scoreCandidate(candidate, ctx = {}) {
  const context = { nowMs: Date.now(), sizeSol: null, solUsd: null, regime: null, lifecycle: null, ...ctx };
  const f = facts(candidate);
  const completeness = dataCompleteness(candidate);
  const components = {
    liquidity: liquidityScore(f),
    momentum: momentumScore(f),
    volumeQuality: volumeQualityScore(f, candidate),
    holderQuality: holderQualityScore(f),
    smartMoney: smartMoneyScore(candidate),
    developerRisk: developerRiskScore(f),
    contractSafety: contractSafetyScore(f),
    narrative: narrativeScore(candidate),
    entryTiming: entryTimingScore(f, context),
    exitFeasibility: exitFeasibilityScore(f, context),
    marketRegime: marketRegimeScore(context),
    dataReliability: dataReliabilityScore(candidate, f, context, completeness.percent),
  };

  const weights = { ...DEFAULT_WEIGHTS, ...(context.weights || {}) };
  let weighted = 0, used = 0, possible = 0;
  const unavailable = [];
  for (const name of COMPONENTS) {
    const weight = Math.max(0, Number(weights[name]) || 0);
    possible += weight;
    const score = components[name].score;
    if (score == null) { unavailable.push(name); continue; }
    weighted += score * weight;
    used += weight;
  }
  const overall = used > 0 ? round(weighted / used, 1) : null;
  const flags = [...new Set(COMPONENTS.flatMap(name => components[name].flags || []))];

  return {
    version: SCORECARD_VERSION,
    overall,
    coverage: possible > 0 ? round(used / possible, 2) : 0,   // share of the weight that had data
    completeness,
    components,
    unavailable,
    flags,
    hardGates: hardGates(candidate),
    weights,
  };
}

// Compact one-line-per-component explanation for logs / Telegram.
export function explainScorecard(card, { max = COMPONENTS.length } = {}) {
  return COMPONENTS.slice(0, max).map(name => {
    const c = card.components[name];
    const label = c.score == null ? 'n/a' : String(Math.round(c.score));
    return `${name} ${label}: ${c.reasons.slice(0, 2).join(', ') || 'no data'}`;
  });
}
