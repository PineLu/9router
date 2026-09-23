const VALID_COMBO_STRATEGIES = new Set(["fallback", "round-robin", "fusion"]);

export function normalizeComboStrategy(strategy, fallback = "fallback") {
  return VALID_COMBO_STRATEGIES.has(strategy) ? strategy : fallback;
}

/**
 * Resolve the effective strategy with the same precedence everywhere:
 * per-combo override -> global legacy setting -> fallback.
 */
export function resolveComboStrategy(settings = {}, comboName) {
  const globalStrategy = normalizeComboStrategy(settings?.comboStrategy, "fallback");
  const specific = settings?.comboStrategies?.[comboName]?.fallbackStrategy;
  return normalizeComboStrategy(specific, globalStrategy);
}

/**
 * Persist a per-combo choice without changing its effective meaning.
 * If the requested strategy equals the global strategy, the redundant override
 * is removed. Otherwise it must remain explicit (notably fallback overriding a
 * legacy global round-robin setting).
 */
export function setComboStrategyOverride(comboStrategies = {}, comboName, strategy, globalStrategy = "fallback") {
  const effectiveGlobal = normalizeComboStrategy(globalStrategy, "fallback");
  const desired = normalizeComboStrategy(strategy, effectiveGlobal);
  const updated = { ...(comboStrategies || {}) };
  const entry = { ...(updated[comboName] || {}) };

  if (desired === effectiveGlobal) {
    delete entry.fallbackStrategy;
  } else {
    entry.fallbackStrategy = desired;
  }

  if (Object.keys(entry).length === 0) delete updated[comboName];
  else updated[comboName] = entry;

  return updated;
}
