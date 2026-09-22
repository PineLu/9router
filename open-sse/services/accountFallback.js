import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}


/**
 * Detect provider-native safety refusals that are scoped to the current request,
 * not to credential/model health.
 *
 * CodeBuddy returns HTTP 403 for safety review failures (not auth failures), e.g.:
 *   code=11140, "request illegal", "The content did not pass the safety review."
 * Treating that as a generic 403 poisons modelLock_* for unrelated requests.
 */
export function isRequestScopedSafetyError(status, errorText, provider = null) {
  if (Number(status) !== 403) return false;

  const providerId = String(provider || "").toLowerCase();
  const isCodeBuddy = providerId === "codebuddy"
    || providerId === "codebuddy-intl"
    || providerId === "codebuddy-cn";
  if (!isCodeBuddy) return false;

  let text = "";
  try {
    text = typeof errorText === "string"
      ? errorText
      : JSON.stringify(errorText ?? "");
  } catch {
    text = String(errorText ?? "");
  }

  const lower = text.toLowerCase();
  return /["']?code["']?\s*:\s*["']?11140["']?/i.test(text)
    || lower.includes("content did not pass the safety review")
    || text.includes("内容未通过安全审核")
    || text.includes("內容未通過安全審核");
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * 429 with an upstream retry window ("Try again in Nm" / retryAfter) honors the
 * window (capped at MAX_RATE_LIMIT_COOLDOWN_MS); without one falls back to
 * exponential backoff. Same policy as combo-level recordComboFailure.
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @param {string|null} retryAfter - Optional ISO retry-after timestamp from upstream
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, retryAfter = null, provider = null) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  // CodeBuddy uses HTTP 403 for request-level safety review failures. Do not
  // rotate credentials or persist model/account health state for this request.
  if (isRequestScopedSafetyError(status, errorText, provider)) {
    return { shouldFallback: false, cooldownMs: 0, scope: "request_safety" };
  }

  // 429 first: upstream retry window wins over blind backoff.
  if (status === 429) {
    const upstream = parseUpstreamRetryMs(
      typeof errorText === "string" ? errorText : JSON.stringify(errorText ?? ""),
      retryAfter
    );
    if (upstream > 0) {
      return { shouldFallback: true, cooldownMs: Math.min(upstream, MAX_RATE_LIMIT_COOLDOWN_MS) };
    }
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Request-scoped client errors that matched no rule above say nothing about
  // credential health. Preserve upstream v0.5.81 semantics while keeping our
  // provider retry-window handling above.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/**
 * Parse a provider-reported retry window into ms: an ISO retryAfter timestamp,
 * or "Try again in 31m/45s/2h" (incl. compound "6h 37m") embedded in the error
 * text. Returns 0 if none. Shared by account-level checkFallbackError and
 * combo-level recordComboFailure so both layers honor upstream retry windows.
 */
export function parseUpstreamRetryMs(errorText, retryAfter, now = Date.now()) {
  if (retryAfter) {
    const ts = new Date(retryAfter).getTime();
    if (Number.isFinite(ts) && ts > now) return ts - now;
  }
  if (typeof errorText === "string") {
    // Supports compound windows like "Try again in 6h 37m" (sums all parts).
    const re = /(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/gi;
    // Anchor to a "try again in ..." clause so unrelated numbers don't match.
    const clause = errorText.match(/try again in[^.!\n]{0,60}/i);
    const scope = clause ? clause[0] : null;
    if (scope) {
      let total = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(scope)) !== null) {
        const n = Number.parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        if (unit.startsWith("h")) total += n * 3600 * 1000;
        else if (unit.startsWith("m")) total += n * 60 * 1000;
        else total += n * 1000;
      }
      if (total > 0) return total;
    }
  }
  return 0;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
