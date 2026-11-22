// Shared helpers for the intelligence layer. Pure.

// A number, or null when the source value is missing / not numeric. Missing data
// must stay null — it is never turned into 0, because 0 is a real measurement.
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clamp(value, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, value));
}

// Linear map of x from [lo, hi] onto [0, 100] (clamped). lo > hi inverts it.
export function scale(x, lo, hi) {
  if (x == null) return null;
  if (lo === hi) return x >= hi ? 100 : 0;
  return clamp(((x - lo) / (hi - lo)) * 100);
}

export function ratio(a, b) {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

// Average of the available parts. Returns null when fewer than `min` parts exist,
// so a component never reports a score built on almost nothing.
export function blend(parts, min = 1) {
  const present = parts.filter(p => p && p.value != null);
  if (present.length < min) return null;
  const weight = present.reduce((sum, p) => sum + (p.weight ?? 1), 0);
  if (weight <= 0) return null;
  return present.reduce((sum, p) => sum + p.value * (p.weight ?? 1), 0) / weight;
}

export function median(values) {
  const xs = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function round(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
