# v0.5.85 Sync Verification Guide

Target staging branch:

```text
sync-upstream-0922-v0.5.85
```

Merge foundation:

```text
844ab841ffe4c8ef243593da4e50b26f64aa99b7
```

Post-merge code repair candidate:

```text
0674530df59c4bc63d3a9a373010091dd08e1c7a
```

The staging branch may contain documentation-only commits after the code repair candidate.

Merge parents:

```text
6ccf3fb8b76918af91d53fec815272f515a1d80a   fork/custom branch before sync
21583c03e5c5d5276924efad82328ebe6e215854   upstream v0.5.85
```

This guide is a merge gate. **Do not modify code while running it.**  
Do not merge the staging branch into `feat/combo-health-fallback` unless every hard acceptance criterion passes.

---

## 1. Update local staging branch

```bash
cd ~/tujia_workspace/9router

git fetch origin
git fetch upstream

git checkout sync-upstream-0922-v0.5.85
git pull --ff-only origin sync-upstream-0922-v0.5.85

git status
git rev-parse HEAD
git log --graph --oneline --decorate -8
```

The merge foundation and repaired code candidate must both be ancestors of HEAD:

```bash
git merge-base --is-ancestor 844ab841ffe4c8ef243593da4e50b26f64aa99b7 HEAD
echo "merge foundation=$?"

git merge-base --is-ancestor 0674530df59c4bc63d3a9a373010091dd08e1c7a HEAD
echo "code repair candidate=$?"
```

Expected exit codes: both `0`.

Working tree must be clean.

---

## 2. Verify merge ancestry

```bash
git merge-base --is-ancestor 6ccf3fb8b76918af91d53fec815272f515a1d80a HEAD
echo "fork parent ancestor=$?"

git merge-base --is-ancestor 21583c03e5c5d5276924efad82328ebe6e215854 HEAD
echo "upstream parent ancestor=$?"
```

Both exit codes must be 0.

Also:

```bash
git rev-list --parents -n 1 HEAD
```

The merge commit must have both parents.

---

## 3. Static fork-invariant checks

### SQLite PRAGMA

```bash
grep -nE 'journal_mode|synchronous|mmap_size' src/lib/db/schema.js
```

Required:

```text
journal_mode = DELETE
synchronous = FULL
mmap_size = 0
```

### Native adapter shutdown ownership

```bash
grep -nE 'process\.once\("(SIGINT|SIGTERM|beforeExit)"' \
  src/lib/db/adapters/betterSqliteAdapter.js \
  src/lib/db/adapters/nodeSqliteAdapter.js \
  src/lib/db/adapters/bunSqliteAdapter.js
```

Expected: no output.

```bash
grep -n 'process.once("exit", onExit)' \
  src/lib/db/adapters/betterSqliteAdapter.js \
  src/lib/db/adapters/nodeSqliteAdapter.js \
  src/lib/db/adapters/bunSqliteAdapter.js
```

Expected: one match per adapter.

### No stale WAL checkpoint logic

```bash
if grep -R -n 'wal_checkpoint\|CHECKPOINT_INTERVAL_MS' src/lib/db/adapters; then
  echo "FAIL: stale WAL checkpoint logic"
  exit 1
else
  echo "PASS: no WAL checkpoint logic"
fi
```

### Request Detail reliability

```bash
grep -nE 'activeFlushPromise|scheduleFlush\(config\.flushIntervalMs\)|OBSERVABILITY_MAX_BUFFER_RECORDS|_requestDetailsShutdownHandlers' \
  src/lib/db/repos/requestDetailsRepo.js
```

All four behaviors must still be present.

### Combo health

```bash
grep -nE 'comboHealthState|recordComboFailure|isComboModelCooling' open-sse/services/combo.js
```

### Attribution

```bash
grep -R -n 'comboName\|requestedModel' \
  open-sse/handlers/chatCore.js \
  open-sse/handlers/chatCore \
  src/lib/db/repos/usageRepo.js
```

### Deploy invariants

```bash
bash -n 9r-deploy.sh

grep -n 'USER_UID="$(id -u)"' 9r-deploy.sh
grep -n 'NINEROUTER_VERIFY_KEY' 9r-deploy.sh

if grep -n 'gui/501' 9r-deploy.sh; then
  echo "FAIL: hardcoded launchd UID"
  exit 1
fi
```

Do not remove or rotate the retained default verification Key during testing.

---

## 4. Install test dependencies if needed

```bash
cd tests
npm install
```

If dependencies are already current, this may be skipped.

---

## 5. v0.5.85 upstream-targeted tests

Run:

```bash
npm test -- \
  --config ./vitest.config.js \
  unit/opencode-fingerprint.test.js \
  unit/opencode-session.test.js \
  unit/opencode-zen-models.test.js \
  unit/cursor-agent-exec-request.test.js \
  unit/cursor-agent-proto.test.js \
  unit/rtk-cursor-pretranslate.test.js \
  unit/claude-refusal-stream.test.js \
  unit/openai-responses-usage-completed.test.js \
  unit/qoder-billing.test.js \
  unit/qoder-proxy-replay.test.js \
  unit/qoder-stream-errors.test.js \
  unit/combo-capabilities.test.js \
  unit/combo-presets.test.js \
  unit/capabilities.test.js \
  unit/param-support.test.js \
  unit/thinking-budget-max-level.test.js
```

Required: **0 failed**.

These cases specifically cover:

- OpenCode fingerprint/tool restoration
- OpenCode Zen provider/model catalog
- Cursor AgentService tools/protobuf/RTK pre-translate
- Claude `stop_reason=refusal` mapping
- Responses usage on `response.completed`
- Qoder billing/replay/error-status handling
- Combo capability aggregation
- Combo preset generation
- reasoning-field cleanup and max tier

---

## 6. Fork core regression set

Run:

```bash
npm test -- \
  --config ./vitest.config.js \
  unit/combo-health-fallback.test.js \
  unit/combo-content-filter.test.js \
  unit/request-details-retry.test.js \
  unit/dashboard-guard.test.js \
  unit/commandcode-executor.test.js \
  unit/model-routing.test.js \
  unit/compatible-provider-connections.test.js
```

Required: **0 failed**.

Important assertions that must remain:

- refusal does not call `onRequestSuccess`
- refusal usage is still persisted
- ambiguous inability wording is not classified as policy refusal
- Request Detail final failure requeues
- requeued batch retries without a new request
- shutdown waits for an in-flight flush
- temporary DB directories do not reuse a stale global adapter
- CommandCode still receives the combo context third argument

---

## 7. DB reliability loop: 5 runs

```bash
for i in {1..5}; do
  echo "===== DB RELIABILITY RUN $i ====="
  npm test -- \
    --config ./vitest.config.js \
    unit/request-details-retry.test.js \
    unit/model-routing.test.js \
    unit/compatible-provider-connections.test.js || exit 1
done
```

Required:

```text
5/5 PASS
```

---

## 8. Additional merged-file regression

Run:

```bash
npm test -- \
  --config ./vitest.config.js \
  unit/combo-content-filter.test.js \
  unit/openai-responses-usage-completed.test.js \
  unit/qoder-stream-errors.test.js \
  unit/opencode-fingerprint.test.js \
  unit/combo-capabilities.test.js \
  unit/combo-presets.test.js
```

This is the focused coverage for the eight manually reconciled files.

---

## 9. Full unit suite

Before comparing branch/master failures, make sure native modules were built for the same
Node ABI used to execute Vitest:

```bash
node -v
node -p 'process.versions.modules'
cd ~/tujia_workspace/9router
npm rebuild better-sqlite3
cd tests
```

If a failure contains `NODE_MODULE_VERSION ... vs ...`, treat that run as an invalid
environment comparison, rebuild `better-sqlite3` under the active Node, and rerun the
affected test before calculating NEW REGRESSIONS.

Then run:

```bash
npm test -- --config ./vitest.config.js unit 2>&1 | tee /tmp/9router-v0585-sync-unit.log
```

Record:

- failed
- passed
- skipped
- total

**Do not use the old 89/90 failure counts as the acceptance criterion.**

v0.5.85 contains upstream fixes, especially Cursor, so the upstream baseline may have changed.

The only valid hard criterion is:

```text
NEW REGRESSIONS (pass on v0.5.85 master, fail on sync branch) = 0
```

---

## 10. Fresh v0.5.85 master baseline

Use a detached worktree from the exact upstream/master commit now mirrored by origin/master:

```bash
cd ~/tujia_workspace/9router

BASE_SHA=21583c03e5c5d5276924efad82328ebe6e215854
BASE_WT=/tmp/9router-v0585-master-baseline

rm -rf "$BASE_WT"
git worktree add --detach "$BASE_WT" "$BASE_SHA"

cd "$BASE_WT/tests"
npm install
npm test -- --config ./vitest.config.js unit 2>&1 | tee /tmp/9router-v0585-master-unit.log
```

Compare **failing test-case names**, not merely aggregate counts:

```text
NEW REGRESSIONS = sync failures - v0.5.85 master failures
FIXED           = v0.5.85 master failures - sync failures
```

Hard requirement:

```text
NEW REGRESSIONS = 0
```

Report any upstream baseline failures fixed by the fork separately.

Cleanup:

```bash
cd ~/tujia_workspace/9router
git worktree remove "$BASE_WT" --force
```

---

## 11. Build

From repository root:

```bash
cd ~/tujia_workspace/9router
git checkout sync-upstream-0922-v0.5.85

npm run build
```

Required:

```text
EXIT=0
```

No syntax/import/build error is acceptable.

---

## 12. Dashboard/manual static smoke before deployment

Start with code/static inspection only.

Verify Combos page still has both:

- upstream preset/bulk/capability features
- fork cooling banner

Search:

```bash
grep -nE 'handleGeneratePresets|handleBulkDelete|aggregateComboCapabilities|/api/combos/health|cooling' \
  'src/app/(dashboard)/dashboard/combos/page.js'
```

Verify Usage UI has both:

- fork Health card
- upstream All Time / provider/model charts

```bash
grep -nE 'stats\.health|value: "all"|ProviderBarChart|TopModelsChart' \
  src/app/'(dashboard)'/dashboard/usage/components/OverviewCards.js \
  src/shared/components/UsageStats.js
```

---

## 13. New route/provider sanity

Verify files/routes exist:

```bash
test -f src/app/api/v1/systemone/route.js
test -f src/sse/handlers/systemone.js
test -f open-sse/handlers/systemoneCore.js
test -f open-sse/providers/registry/opencode-zen.js
test -f open-sse/executors/opencode-zen.js

echo "PASS: System One + OpenCode Zen files present"
```

---

## 14. Database integrity before deployment

The database may still reflect the currently/previously deployed build before this staging
candidate has ever started. Therefore **pre-deploy** this section checks integrity only;
`journal_mode` and `backupSchemaVersion` are observations, not blockers.

```bash
DB="$HOME/.9router/db/data.sqlite"

sqlite3 -readonly "$DB" "
PRAGMA quick_check;
PRAGMA journal_mode;
SELECT key, value FROM _meta WHERE key='backupSchemaVersion';
"
```

Pre-deploy hard requirement:

```text
quick_check = ok
```

Record the current journal/schema values. If they are still `wal` / schema 1, that is
acceptable **before first staging deployment** provided source/static checks already prove:

```text
SCHEMA_VERSION = 2
journal_mode = DELETE
synchronous = FULL
mmap_size = 0
```

After Section 15 deployment, the runtime DB **must** become:

```text
quick_check = ok
journal_mode = delete
backupSchemaVersion = 2
```

If it does not, deployment fails.

---

## 15. Deployment smoke

Only execute after Sections 1–14 pass.

```bash
cd ~/tujia_workspace/9router
./9r-deploy.sh
```

Required:

- build/restart succeeds
- launchd service healthy
- `/v1/models` works
- new-api -> host verification works
- `journal_mode=delete`
- `quick_check=ok`
- malformed count = 0

After deployment:

```bash
sqlite3 -readonly "$HOME/.9router/db/data.sqlite" "PRAGMA quick_check; PRAGMA journal_mode;"
tail -150 "$HOME/.9router/logs/9router-local.out.log"
tail -150 "$HOME/.9router/logs/9router-local.err.log"
```

---

## 16. Live functional smoke

Use safe prompts only.

### Normal direct request

Verify a normal non-stream and stream request.

### Combo request

Verify fallback routing and inspect DB attribution:

```sql
SELECT
  requestedModel,
  comboName,
  provider,
  model,
  status
FROM usageHistory
ORDER BY id DESC
LIMIT 20;
```

Expected:

- `requestedModel` = caller's model
- `comboName` = combo name for combo requests
- actual provider/model = final selected target

### OpenCode Zen

If available, verify:

- provider appears
- free model request works
- request containing tools does not fail only because fingerprint quartet is missing

### System One / JEV

If provider access is available, test `POST /v1/systemone` with a valid decision request.

Do not classify lack of OpenRouter access caused by the account's regional/billing policy as a 9Router regression.

### Cursor

If a working Cursor connection is available, exercise one tool-call turn and ensure there is no empty turn/tool hang.

---

## 17. Known issue explicitly outside this sync

The following issue is **not fixed by v0.5.85** and must not be used as a sync failure:

```text
codebuddy-intl
HTTP 403
code=11140
"内容未通过安全审核"
-> current generic 403 account classifier may persist a 120s modelLock
```

This is a separate failure-scope classification task.

Do not modify it during this validation.

---

## 18. Final report format

Return:

```text
1. Tested commit SHA
2. git status
3. v0.5.85 upstream-targeted tests
4. fork core regression tests
5. DB reliability 5/5
6. merged-file focused regression
7. sync full unit: failed/passed/skipped/total
8. v0.5.85 master full unit: failed/passed/skipped/total
9. NEW REGRESSIONS count + exact case names
10. FIXED count + exact case names
11. npm run build result
12. static SQLite/adapter/WAL checks
13. Combo/Usage merged UI checks
14. DB quick_check/journal/schema version
15. deployment smoke
16. live OpenCode Zen/System One/Cursor/Combo observations
17. warnings/unexpected logs
```

---

## 19. Hard acceptance criteria

All must pass before merging staging into `feat/combo-health-fallback`:

- merge foundation `844ab841ffe4c8ef243593da4e50b26f64aa99b7` and repaired code candidate `0674530df59c4bc63d3a9a373010091dd08e1c7a` are ancestors of staging HEAD
- both merge parents are ancestors
- targeted upstream tests: 0 failed
- fork core tests: 0 failed
- DB reliability: 5/5
- NEW REGRESSIONS vs v0.5.85 master: 0
- build: EXIT=0
- SQLite remains DELETE/FULL/mmap=0
- no native adapter SIGINT/SIGTERM/beforeExit DB-close listeners
- no stale WAL checkpoint code
- Request Detail single-flight/requeue/auto-retry preserved
- Combo health/cooling preserved
- refusal handling preserved
- comboName/requestedModel attribution preserved
- upstream All Time / Requests / breakdown analytics preserved
- upstream Combo presets/capabilities preserved
- deploy script syntax passes and dynamic UID remains
- pre-deploy database quick_check=ok
- after deployment: quick_check=ok, journal_mode=delete, backupSchemaVersion=2
- deployment smoke passes

If any hard criterion fails, **do not merge the staging branch into the development branch**.
