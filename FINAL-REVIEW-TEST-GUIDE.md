# Final Review Fixes — Local Agent Verification Guide

> Branch: `feat/combo-health-fallback`
>
> Purpose: validate the final merge-review fixes for request-detail flush/shutdown reliability, automatic requeue retry, refusal false-positive hardening, and streaming success timing.
>
> Do not change production behavior while testing. If a test fails, report the failure first; do not revert SQLite to WAL or loosen assertions to make the suite green.

## 1. Scope of this verification

The final-review patch is expected to satisfy all of the following:

1. `flushToDatabase()` is single-flight: shutdown waits for an already-running flush.
2. SQLite adapters do not close the DB on SIGINT/SIGTERM/beforeExit before the async flush completes.
3. A final Request Detail DB write failure requeues the batch and schedules a later retry even if no new request arrives.
4. Hot module reload does not stack Request Detail SIGINT/SIGTERM/beforeExit listeners.
5. Ambiguous normal language is not treated as content-filter refusal:
   - `I can't help but notice a race condition here.`
   - `I cannot provide an exact estimate without the logs.`
   - `I cannot answer definitively without more context.`
   - `我无法判断具体原因，需要你提供更多日志。`
6. Explicit policy/safety refusals still match.
7. Streaming does not call `onRequestSuccess` merely because HTTP 200 started.
8. Streaming content-filter/refusal does not call `onRequestSuccess`.
9. Streaming normal terminal completion calls `onRequestSuccess` exactly once.
10. HTTP 200 + HTML/non-SSE error response does not call `onRequestSuccess`.
11. SQLite remains DELETE/FULL/mmap=0.
12. No branch-only unit-test regression is introduced.

---

## 2. Update local branch

From repository root:

```bash
git fetch origin
git checkout feat/combo-health-fallback
git pull --ff-only origin feat/combo-health-fallback

git status
git log --oneline -12
```

Expected:

- working tree clean before testing
- local branch aligned with `origin/feat/combo-health-fallback`

Do not test an older local commit.

---

## 3. Static review: SQLite shutdown ownership

Run from repository root:

```bash
grep -nE 'process\.once\("(SIGINT|SIGTERM|beforeExit)"' \
  src/lib/db/adapters/betterSqliteAdapter.js \
  src/lib/db/adapters/nodeSqliteAdapter.js \
  src/lib/db/adapters/bunSqliteAdapter.js
```

Expected: **no output**.

Then:

```bash
grep -n 'process.once("exit", onExit)' \
  src/lib/db/adapters/betterSqliteAdapter.js \
  src/lib/db/adapters/nodeSqliteAdapter.js \
  src/lib/db/adapters/bunSqliteAdapter.js
```

Expected: exactly one match in each of the three adapters.

Reason:

```text
SIGTERM/SIGINT
  -> requestDetailsRepo owns async flush
  -> process.exit()
  -> synchronous exit phase
  -> adapter closes DB
```

The DB must not close before the async Request Detail flush finishes.

---

## 4. Static review: SQLite PRAGMA must not change

```bash
grep -nE 'journal_mode|synchronous|mmap_size' src/lib/db/schema.js
```

Expected:

```text
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA mmap_size = 0;
```

Fail immediately if WAL was reintroduced.

Also confirm stale WAL checkpoint logic is still absent:

```bash
if grep -R -n 'wal_checkpoint\|CHECKPOINT_INTERVAL_MS' src/lib/db/adapters; then
  echo "FAIL: stale WAL checkpoint logic found"
  exit 1
else
  echo "PASS: no WAL checkpoint logic"
fi
```

---

## 5. Install test dependencies if needed

```bash
cd tests
npm install
```

If dependencies are already installed and unchanged, this step may be skipped.

---

## 6. Targeted reliability tests

Still inside `tests/`:

```bash
npm test -- \
  --config ./vitest.config.js \
  unit/request-details-retry.test.js \
  unit/combo-content-filter.test.js
```

Expected: all cases PASS.

Pay special attention to cases covering:

- failed batch requeue
- auto retry with no new request
- bounded buffer
- shutdown waits for in-flight flush
- listener count does not grow after module reload
- ambiguous refusal text false positives
- explicit refusal true positives
- streaming refusal does not call success callback
- streaming normal terminal calls success once
- streaming HTML error does not call success callback

If either file fails, stop and return the complete Vitest failure output.

---

## 7. Repeat DB reliability tests 5 times

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

Expected: all five runs PASS.

This verifies the fix does not depend on:

- test execution order
- stale `global._dbAdapter`
- a deleted temporary DATA_DIR
- WAL inode behavior
- lucky timer ordering

---

## 8. Combo / content-filter regression set

```bash
npm test -- \
  --config ./vitest.config.js \
  unit/combo-health-fallback.test.js \
  unit/combo-content-filter.test.js \
  unit/dashboard-guard.test.js \
  unit/opencode-session.test.js \
  unit/commandcode-executor.test.js \
  unit/model-routing.test.js \
  unit/compatible-provider-connections.test.js \
  unit/request-details-retry.test.js
```

Expected: all listed files PASS.

---

## 9. Explicit refusal heuristic sanity check

The unit suite must prove all of the following:

### Must be false

```text
I can't help but notice a race condition here.
I cannot provide an exact estimate without the logs.
I cannot answer definitively without more context.
我无法判断具体原因，需要你提供更多日志。
A content policy defines which categories require moderation.
```

### Must be true

```text
I can't help with this request due to content policy.
This request violates our content policy.
I'm sorry, I can't help with this request.
抱歉，这个请求涉及敏感内容，我无法提供帮助。
抱歉，我无法帮助处理这个请求。
```

Structured provider signals remain authoritative regardless of text:

```text
OpenAI finish_reason=content_filter
Gemini SAFETY / RECITATION / BLOCKLIST / PROHIBITED_CONTENT
Responses API content item type=refusal
```

---

## 10. Full unit suite

Run:

```bash
npm test -- --config ./vitest.config.js unit
```

Important: **do not require the entire repository to have 0 failures**.

The repository has known historical master baseline failures. Acceptance criterion:

```text
NEW REGRESSIONS (pass on master, fail on branch) = 0
```

Before this final-review patch the verified baseline was:

```text
master: 90 failed
branch: 89 failed
branch-only regressions: 0
```

Because this patch adds new passing tests, the passed/total count may increase. The failure count should not increase due to this patch.

If current branch has more failures than expected, calculate the exact failure-set difference against merge-base/master before concluding there is a regression.

---

## 11. Optional exact master-vs-branch failure diff

If a fresh comparison is needed, use a separate worktree.

From repository root (not `tests/`):

```bash
BASE_SHA="$(git merge-base master feat/combo-health-fallback)"
BASE_WT="/tmp/9router-master-baseline"

rm -rf "$BASE_WT"
git worktree add --detach "$BASE_WT" "$BASE_SHA"
```

Run the same full unit command on both trees and capture logs.

Branch:

```bash
cd <YOUR_9ROUTER_REPO>/tests
npm test -- --config ./vitest.config.js unit 2>&1 | tee /tmp/9router-branch-unit.log
```

Baseline:

```bash
cd "$BASE_WT/tests"
npm install
npm test -- --config ./vitest.config.js unit 2>&1 | tee /tmp/9router-master-unit.log
```

Use the same method used in the previous regression analysis to extract failing test names and calculate:

```text
NEW REGRESSIONS = branch failures - baseline failures
FIXED = baseline failures - branch failures
```

Required:

```text
NEW REGRESSIONS = 0
```

Cleanup:

```bash
cd <YOUR_9ROUTER_REPO>
git worktree remove "$BASE_WT" --force
```

---

## 12. Build

From repository root:

```bash
cd ..
npm run build
```

Expected:

```text
EXIT=0
```

No syntax/import/lint/build errors are acceptable.

---

## 13. Deployment script static validation

```bash
bash -n 9r-deploy.sh
```

Expected: no output and exit 0.

Confirm dynamic launchd UID:

```bash
if grep -n 'gui/501' 9r-deploy.sh; then
  echo "FAIL: hardcoded uid remains"
  exit 1
else
  echo "PASS: dynamic uid"
fi
```

The existing default verification Key is intentionally retained. Do not remove it as part of this test.

---

## 14. Database integrity check

Before deployment:

```bash
DB="$HOME/.9router/db/data.sqlite"

sqlite3 -readonly "$DB" "
PRAGMA quick_check;
PRAGMA journal_mode;
SELECT key, value FROM _meta WHERE key='backupSchemaVersion';
"
```

Expected:

```text
ok
delete
backupSchemaVersion|2
```

---

## 15. Optional live deployment smoke

Only after all automated checks above pass.

This restarts the launchd-managed production instance:

```bash
./9r-deploy.sh --skip-build
```

If the build in step 12 produced the new `.next` output, `--skip-build` is sufficient for the restart/smoke phase.

Expected:

- launchd process starts successfully
- `/v1/models` succeeds
- new-api -> host verification succeeds when container is running
- journal mode remains `delete`
- `PRAGMA quick_check = ok`
- recent logs contain 0 `malformed`

After restart:

```bash
sqlite3 -readonly "$HOME/.9router/db/data.sqlite" "PRAGMA quick_check; PRAGMA journal_mode;"
tail -100 "$HOME/.9router/logs/9router-local.out.log"
```

Expected:

```text
ok
delete
```

and no new SQLite closed-handle / readonly / malformed errors.

---

## 16. Streaming smoke

Use a known working model/combo.

Normal streaming request must complete normally and still write usage/request detail.

If a provider can be made to return an HTML/non-SSE test response in a safe test environment, verify:

```text
HTTP 200 + HTML/non-SSE
-> request returns error
-> account/model success state is NOT cleared by onRequestSuccess
```

Do not intentionally break a production provider merely to manufacture this case; the automated unit test is authoritative.

---

## 17. Final report format

Return exactly this information:

```text
1. Tested commit SHA
2. git status
3. request-details-retry result
4. combo-content-filter result
5. 5x DB reliability result
6. 8-file targeted regression result
7. full unit failed/passed/skipped
8. master-vs-branch NEW REGRESSIONS count
9. npm run build result
10. bash -n 9r-deploy.sh result
11. SQLite quick_check / journal_mode / schema version
12. adapter signal-listener grep result
13. WAL checkpoint grep result
14. optional deployment smoke result
15. any warnings or unexpected logs
```

## 18. Hard acceptance criteria

All of these must hold:

- targeted tests all pass
- DB reliability loop passes 5/5
- branch-only unit regressions = 0
- build exits 0
- SQLite remains DELETE/FULL/mmap=0
- no adapter SIGINT/SIGTERM/beforeExit DB-close listener remains
- adapters close synchronously during process exit
- no stale WAL checkpoint code
- failed Request Detail batch auto-retries without requiring a new request
- shutdown waits for an already-running flush
- hot reload does not stack Request Detail signal listeners
- ambiguous normal inability wording does not trigger content-filter
- explicit policy/safety refusals still trigger
- streaming HTML error does not mark success
- streaming refusal does not mark success
- streaming normal terminal completion marks success exactly once

If any hard criterion fails, do not merge to master.
