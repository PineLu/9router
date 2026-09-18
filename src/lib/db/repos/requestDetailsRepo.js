import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;
// Hard cap on the in-memory pending buffer. A batch that cannot be persisted is
// requeued (never silently dropped), so without a cap a permanently-broken DB
// would grow the buffer without bound. Oldest records are dropped on overflow.
const DEFAULT_MAX_BUFFER_RECORDS = 1000;
// Bounded wait for the final flush during SIGINT/SIGTERM.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders, flushToDatabase };

function getMaxBufferRecords() {
  const n = parseInt(
    process.env.OBSERVABILITY_MAX_BUFFER_RECORDS || String(DEFAULT_MAX_BUFFER_RECORDS),
    10
  );
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUFFER_RECORDS;
}

/**
 * Single entry point for the pending buffer. `front` is used to requeue a batch
 * whose final DB write failed: those records are older than anything pushed
 * since, so they go back at the head. Overflow drops the OLDEST records and
 * keeps the newest — losing the stale tail of an unpersistable backlog beats
 * losing the request that just happened.
 */
function enqueueDetails(items, { front = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) return;

  if (front) writeBuffer.unshift(...items);
  else writeBuffer.push(...items);

  const max = getMaxBufferRecords();
  if (writeBuffer.length > max) {
    const overflow = writeBuffer.length - max;
    writeBuffer.splice(0, overflow);
    console.error(
      `[requestDetailsRepo] Buffer overflow: dropped ${overflow} oldest request detail record(s); max=${max}`
    );
  }
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      // Retry on SQLITE_BUSY / lock contention: without this a transient lock
      // drops the whole drained batch silently (usage rows + detail rows lost,
      // and usageHistory IDs skip — see 9router#3488). Back off and retry.
      const BUSY_RETRIES = 4;
      let persisted = false;
      for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
        try {
          db.transaction(() => {
            for (const item of items) {
              if (!item.id) item.id = generateDetailId(item.model);
              if (!item.timestamp) item.timestamp = new Date().toISOString();
              if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

              const record = {
                id: item.id,
                provider: item.provider || null,
                model: item.model || null,
                requestedModel: item.requestedModel || null,
                comboName: item.comboName || null,
                connectionId: item.connectionId || null,
                timestamp: item.timestamp,
                status: item.status || null,
                latency: item.latency || {},
                tokens: item.tokens || {},
                request: truncateField(item.request, config.maxJsonSize),
                providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
                providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
                response: truncateField(item.response, config.maxJsonSize),
                pxpipe: item.pxpipe || undefined,
              };

              db.run(
                `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, comboName, requestedModel, status, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, comboName = excluded.comboName, requestedModel = excluded.requestedModel, status = excluded.status, data = excluded.data`,
                [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.comboName, record.requestedModel, record.status, stringifyJson(record)]
              );
            }

            const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
            if (cnt && cnt.c > config.maxRecords) {
              db.run(
                `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
                [cnt.c - config.maxRecords]
              );
            }
          });
          persisted = true;
          break; // success
        } catch (e) {
          const msg = String(e?.message || e);
          const transient = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|disk I\/O error/i.test(msg);
          if (!transient || attempt >= BUSY_RETRIES) {
            console.error(`[requestDetailsRepo] Batch write failed (attempt ${attempt + 1}/${BUSY_RETRIES + 1}):`, e);
            break;
          }
          await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
          console.warn(`[requestDetailsRepo] Transient DB error, retrying (${attempt + 1}/${BUSY_RETRIES}): ${msg}`);
        }
      }

      // Final failure: put the batch back instead of losing it, then stop this
      // drain. Requeue-then-continue would re-drain the same failing batch in a
      // tight loop (CPU + log spam), so we return and let the next timer tick,
      // saveRequestDetail() call, or shutdown attempt retry it.
      if (!persisted) {
        enqueueDetails(items, { front: true });
        console.error(
          `[requestDetailsRepo] Requeued ${items.length} request detail record(s) after final DB write failure`
        );
        break;
      }
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  enqueueDetails([detail]);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.combo) { conds.push("comboName = ?"); params.push(filter.combo); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.error) { conds.push("data LIKE ?"); params.push(`%${filter.error}%`); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

export async function getDistinctCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT comboName FROM requestDetails WHERE comboName IS NOT NULL AND comboName != '' ORDER BY comboName ASC`);
  return rows.map((r) => r.comboName);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

// ---------------------------------------------------------------------------
// Shutdown lifecycle
//
// `process.on("exit", handler)` CANNOT run async work — Node does not await the
// promise, so an async flush registered there only *looks* safe. beforeExit can
// run async work, but it is not emitted on SIGINT/SIGTERM. Signals therefore
// get their own bounded graceful flush below.
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function flushPendingForShutdown() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  try {
    await Promise.race([
      flushToDatabase(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("request detail flush timeout")), SHUTDOWN_FLUSH_TIMEOUT_MS)
      ),
    ]);
  } catch (e) {
    console.error(`[requestDetailsRepo] ${signal} flush failed:`, e);
  }

  process.exit(0);
}

const _beforeExitHandler = async () => { await flushPendingForShutdown(); };
const _sigintHandler = () => { void gracefulShutdown("SIGINT"); };
const _sigtermHandler = () => { void gracefulShutdown("SIGTERM"); };

function ensureShutdownHandler() {
  // Re-register on module reload (hot reload) without stacking duplicate listeners.
  process.off("beforeExit", _beforeExitHandler);
  process.off("SIGINT", _sigintHandler);
  process.off("SIGTERM", _sigtermHandler);

  process.on("beforeExit", _beforeExitHandler);
  process.on("SIGINT", _sigintHandler);
  process.on("SIGTERM", _sigtermHandler);
}

// Test-only surface. Deliberately excludes gracefulShutdown(): it calls
// process.exit(0), which would tear down the test runner. Tests drive the
// flush through flushPendingForShutdown() instead.
export const __shutdownTest__ = { flushPendingForShutdown, _beforeExitHandler };

ensureShutdownHandler();
