# feat/combo-health-fallback 回归测试方案

> 目标：验证本分支的 Combo health/fallback、content-filter、Responses SSE→JSON、usage 归因、数据库 schema、Request Detail 鉴权和宿主机部署脚本改动。
>
> 原则：先跑纯单测和构建，再跑临时 DATA_DIR，新库验证通过后再碰本机正式数据和 launchd 服务。

## 1. 测试范围

本轮重点覆盖：

1. `usageHistory.requestedModel` / `comboName` schema 与写入链路。
2. `SCHEMA_VERSION=2` 和 schema 变更后的备份版本戳。
3. Combo failure memory / cooling / fallback。
4. OpenAI Chat / Gemini / OpenAI Responses 的 silent refusal 检测。
5. 强制 Responses SSE → JSON 的正常响应和拒答响应。
6. Streaming `finish_reason=stop` + 拒答文本的 cooling。
7. content-filter 短文本误判回归。
8. `/api/usage/request-details/[id]` 强制鉴权。
9. `9r-deploy.sh` 不再包含明文 Key，launchd UID 动态获取。
10. OpenCode session 相关既有回归，避免本分支其他改动被破坏。

## 2. 前置准备

在仓库根目录：

```bash
git checkout feat/combo-health-fallback
git status
node -v
npm -v
```

建议先确认工作区干净。如果本地有未提交改动，先保存，避免测试过程中混入额外变量。

安装应用依赖：

```bash
npm install
```

安装测试依赖：

```bash
cd tests
npm install
cd ..
```

## 3. 第一阶段：定向自动化测试

在仓库根目录执行：

```bash
cd tests

npm test -- \
  --config ./vitest.config.js \
  unit/combo-health-fallback.test.js \
  unit/combo-content-filter.test.js \
  unit/dashboard-guard.test.js \
  unit/opencode-session.test.js
```

### 通过标准

所有测试必须 PASS，重点关注以下 case：

- OpenAI `finish_reason=content_filter` 被识别。
- Gemini `SAFETY / RECITATION` 被识别。
- Responses API `type=refusal` 被识别。
- Responses API `output_text` 明确拒答被识别。
- 正常 Responses SSE → JSON 不再因未定义变量返回 502。
- Responses 拒答 SSE → JSON 返回 403，供 Combo fallback。
- streaming `finish_reason=stop` + 明确拒答文本进入 cooling。
- streaming 正常 `stop` 不进入 cooling。
- 短文本 `content policy / sensitive content / policy violation / 内容违规` 的正常讨论不被误判。
- `comboName/requestedModel` 会传入 `saveRequestUsage`。
- `requireLogin=false` 时 request-detail 列表仍可按原规则访问。
- `requireLogin=false` 时单条完整 request detail 无 token 必须 401。
- 有合法 CLI token 时单条完整 request detail 可访问。

如果此阶段失败，不继续部署测试。

## 4. 第二阶段：全量 unit 回归

仍在 `tests/` 目录：

```bash
npm test -- --config ./vitest.config.js unit
```

### 通过标准

- unit 测试 0 failed。
- 不出现新的 unhandled rejection / uncaught exception。
- 不出现新增的 SQLite schema 错误。

完成后回仓库根目录：

```bash
cd ..
```

## 5. 第三阶段：构建验证

```bash
npm run build
```

### 通过标准

- Next.js build 成功。
- postbuild 成功。
- 不出现 import/export、语法、alias 解析错误。
- 特别不能出现 `parsed is not defined`、`requestedModel` schema 相关错误。

## 6. 第四阶段：部署脚本静态检查

先只做语法和敏感信息检查，不重启服务：

```bash
bash -n 9r-deploy.sh
```

预期：无任何输出，退出码为 0。

检查不再硬编码 UID 501：

```bash
if grep -n 'gui/501' 9r-deploy.sh; then
  echo "FAIL: 仍存在硬编码 UID 501"
else
  echo "PASS: launchd UID 动态获取"
fi
```

检查当前文件没有硬编码 API Key：

```bash
if grep -nE 'KEY=.*sk-|Bearer sk-' 9r-deploy.sh; then
  echo "FAIL: 当前脚本仍包含疑似明文 Key"
else
  echo "PASS: 当前脚本无明文 Key"
fi
```

确认环境变量入口存在：

```bash
grep -n 'NINEROUTER_VERIFY_KEY' 9r-deploy.sh
```

> 注意：旧 Key 曾进入 Git 历史。当前文件删除明文并不能撤销历史泄露。如果该 Key 仍有效，应在 9Router 中废弃/轮换旧 Key。

## 7. 第五阶段：全新数据库验证（安全，不碰正式库）

使用独立临时 DATA_DIR：

```bash
TMP_DATA="$(mktemp -d)"
echo "$TMP_DATA"

DATA_DIR="$TMP_DATA" node custom-server.js --port 20129 >"$TMP_DATA/server.log" 2>&1 &
TEST_PID=$!

sleep 8

curl -fsS http://localhost:20129/api/health || {
  echo "临时实例启动失败"
  tail -100 "$TMP_DATA/server.log"
}

kill "$TEST_PID" 2>/dev/null || true
wait "$TEST_PID" 2>/dev/null || true
```

检查新库：

```bash
sqlite3 "$TMP_DATA/db/data.sqlite" "
PRAGMA quick_check;
PRAGMA journal_mode;
SELECT key, value FROM _meta WHERE key='backupSchemaVersion';
SELECT name FROM pragma_table_info('usageHistory')
 WHERE name IN ('comboName','requestedModel')
 ORDER BY name;
SELECT name FROM pragma_table_info('requestDetails')
 WHERE name IN ('comboName','requestedModel')
 ORDER BY name;
"
```

### 预期结果

至少看到：

```text
ok
delete
backupSchemaVersion|2
comboName
requestedModel
comboName
requestedModel
```

这一步验证“从零建库”的源码 schema 与当前生产数据库结构一致。

测试完成后：

```bash
rm -rf "$TMP_DATA"
```

## 8. 第六阶段：正式库只读检查

这一步不修改数据库：

```bash
DB="$HOME/.9router/db/data.sqlite"

sqlite3 -readonly "$DB" "
PRAGMA quick_check;
PRAGMA journal_mode;
SELECT key, value FROM _meta
 WHERE key IN ('backupSchemaVersion','schemaVersion');
SELECT cid,name,type FROM pragma_table_info('usageHistory')
 WHERE name IN ('comboName','requestedModel');
SELECT cid,name,type FROM pragma_table_info('requestDetails')
 WHERE name IN ('comboName','requestedModel');
"
```

### 通过标准

- `quick_check = ok`
- `journal_mode = delete`
- 应用启动过新代码后，`backupSchemaVersion = 2`
- 两张表都具备 `comboName` 和 `requestedModel`

如果正式库本来已经手工存在 `requestedModel`，升级过程不应重复添加列或报错。

## 9. 第七阶段：实际 Combo usage 归因验证

准备一个真实 Combo，例如：

```bash
export TEST_COMBO="<你的Combo名称>"
export TEST_API_KEY="<本机测试Key>"
```

发一个最小非流式请求：

```bash
curl -sS http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $TEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_COMBO\",
    \"stream\": false,
    \"messages\": [
      {\"role\": \"user\", \"content\": \"reply exactly: regression-ok\"}
    ]
  }"
```

然后检查最近 usage：

```bash
sqlite3 -header -column "$HOME/.9router/db/data.sqlite" "
SELECT
  id,
  timestamp,
  requestedModel,
  comboName,
  provider,
  model,
  promptTokens,
  completionTokens,
  status
FROM usageHistory
ORDER BY id DESC
LIMIT 10;
"
```

### 通过标准

对于刚才的 Combo 请求：

- `requestedModel = TEST_COMBO`
- `comboName = TEST_COMBO`
- `provider` 为最终实际供应商
- `model` 为最终实际执行模型
- token 列正常写入

如测试 streaming，再发一次 `"stream": true`，确认 streaming usage 同样写入这两个字段。

## 10. 第八阶段：Request Detail 鉴权验证

自动化单测已经覆盖该边界。若要做 live smoke，建议在测试环境或确认当前 `requireLogin=false` 时执行。

取一个 detail ID：

```bash
DETAIL_ID="$(sqlite3 "$HOME/.9router/db/data.sqlite"   "SELECT id FROM requestDetails ORDER BY timestamp DESC LIMIT 1;")"

echo "$DETAIL_ID"
```

无 JWT / CLI token 请求单条详情：

```bash
curl -sS -o /tmp/9r-detail.out -w '%{http_code}\n' \
  "http://localhost:20128/api/usage/request-details/$DETAIL_ID"
```

### 预期

即使 `requireLogin=false`，单条完整详情仍应：

```text
401
```

而 redacted 列表接口在 `requireLogin=false` 下保持原行为：

```bash
curl -sS -o /tmp/9r-list.out -w '%{http_code}\n' \
  "http://localhost:20128/api/usage/request-details"
```

预期为 200。

如果当前 `requireLogin=true`，列表无登录状态返回 401 属于正常行为，不算回归。

## 11. 第九阶段：部署脚本实跑

这一步会重启正式 launchd 服务，只在前面全部通过后执行。

不做跨容器鉴权验证：

```bash
./9r-deploy.sh --skip-build
```

如要同时验证 `new-api → 9Router`：

```bash
NINEROUTER_VERIFY_KEY="$TEST_API_KEY" ./9r-deploy.sh --skip-build
```

### 通过标准

脚本应依次确认：

- launchd 服务正在运行。
- 宿主机 `/v1/models` 正常。
- 设置 `NINEROUTER_VERIFY_KEY` 时，new-api → host.containers.internal 正常。
- 未设置环境变量时，只跳过跨容器鉴权，不报 Key 缺失错误。
- journal mode 为 `delete`。
- SQLite `quick_check = ok`。
- 最近日志无 `malformed`。

## 12. 第十阶段：人工场景回归

建议至少跑以下实际业务场景：

| 场景 | 预期 |
| --- | --- |
| 普通 Combo 非流式成功 | 第一可用模型成功返回 |
| Combo 首模型 404/403 | 当前请求 fallback 到下一模型 |
| 同一失败模型再次请求 | cooling 期间被跳过 |
| 所有模型 cooling | hard-try，不直接 503 |
| 上游 `content_filter` | fallback/cooling |
| 上游 `stop + 明确拒答文本` | streaming 下一请求 cooling |
| 短文本讨论 content policy | 正常返回，不 fallback |
| Responses provider + client `stream=false` | 正常 JSON，不 502 |
| Responses 明确 refusal | 返回 403 供 Combo fallback |
| OpenCode free/session | session ID/UA 行为与修改前一致 |

## 13. 最终验收标准

以下全部满足才建议合入 master：

- [ ] 定向 Vitest 全 PASS
- [ ] 全量 unit 全 PASS
- [ ] `npm run build` PASS
- [ ] `bash -n 9r-deploy.sh` PASS
- [ ] 当前部署脚本无明文 Key / 无 UID 501
- [ ] 临时 DATA_DIR 新库包含 `usageHistory.requestedModel`
- [ ] `backupSchemaVersion = 2`
- [ ] SQLite `quick_check = ok`
- [ ] journal mode = `delete`
- [ ] 实际 Combo 请求 `comboName/requestedModel` 正确
- [ ] Request Detail 强制鉴权符合预期
- [ ] content-filter 无已知短文本误判
- [ ] 实际部署 smoke PASS

## 14. 失败时请保留的信息

如果有失败，请不要先清理现场，保留：

```bash
git rev-parse HEAD
git status
node -v
npm -v
sqlite3 --version
```

以及：

- 失败的 Vitest case 名和完整 stack。
- `npm run build` 最后 100 行。
- 临时实例的 `$TMP_DATA/server.log`。
- `~/.9router/logs/9router-local.out.log` 相关时间段。
- `PRAGMA quick_check;` 和 `PRAGMA table_info(usageHistory);` 输出。
- 出问题请求对应的 `usageHistory` / `requestDetails` 最近几行（分享前注意脱敏 Prompt、Token、API Key）。

这些信息足够定位是代码回归、schema 升级、Provider 行为还是本机环境问题。
