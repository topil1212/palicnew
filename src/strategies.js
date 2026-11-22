// Daftar strategi yang bisa berjalan bersamaan. Setiap posisi menyimpan id strateginya.
export const STRATEGIES = {
  p6: { id: 'p6', name: 'P6', enabledKey: 'p6_enabled', maxOpenKey: 'p6_max_open', sizeKey: 'p6_size_sol', cooldownMs: (get) => get('p6_cooldown_minutes') * 60_000 },
};

export const strategyName = (id) => STRATEGIES[id]?.name || String(id || '?');
export const strategyOf = (id) => STRATEGIES[id] || STRATEGIES.p6;
