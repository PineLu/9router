# 9Router 维护文档

> 更新：2026-09-13 | 现状：podman-compose 部署；comboName/requestedModel 来源字段已上线并验证；SQLite rollback journal 模式

## 1. 架构总览

```
客户端（Claude Code / cc-connect 等）
  │  localhost:20128  (OpenAI 兼容 /v1/*)
  ▼
9router-local（自建镜像 localhost/9router:local）
  ├─ Next.js 仪表盘（Web UI、combo/渠道配置）
  └─ open-sse 网关（/v1/chat、/v1/models 等实际转发逻辑）
        │  按 combo 配置扇出到各 provider 账号
        ▼
上游 providers（cline / codebuddy-cn / codebuddy-intl / openai-compatible 节点…）
```

同机另有三个独立容器（与 9Router 网关无依赖，给 new-api 业务用）：

| 容器 | 镜像 | 端口 | 说明 |
|---|---|---|---|
| 9router-local | localhost/9router:local（自建） | 20128 | 现役网关，数据挂原数据目录；同时挂着 `new-api_new-api-network`（别名 `9router`，给 new-api 当上游） |
| new-api | calciumion/new-api | 3003→3000 | 计费/中转；渠道 34 以 `http://9router:20128` 接回本网关（容器名 DNS，不走宿主端口） |
| redis | redis:8-alpine | 6379（未映射宿主） | new-api 缓存 |
| postgres | postgres:18-alpine | 15432→5432 | new-api 数据库 |

底层：podman machine（applehv，6C / 8G / 100G，2026-09-13 实测；旧文档写 8C 已纠正）。**podman-compose 部署**（`docker-compose.yml`），与 new-api 同网络（别名 `9router`）。

旧官方容器 `9router`（decolua/9router:latest）停留作回滚，未删除。

## 2. 数据与源码位置

- 网关数据：`~/docker_workspace/9router/data` → 容器内 `/app/data`
  - `db/data.sqlite`：渠道、combo、API key（SQLite，rollback journal 模式）
  - `data-copy/`：验证期拷贝的副本，已无容器使用，可删
- 源码：`9router-src/`，分支 `feat/combo-health-fallback`（已推远端 fork）
- 构建日志：`/tmp/9router-build*.log`
- 损坏备份/恢复产物（2026-09-12）：
  - `db/data.sqlite.corrupt-*`：损坏现场快照（两次），排查后可删
  - `backup_before_combo_field_20260912_205414/`：第一次修库前备份（注意该备份本身也是从损坏库拷的，仅作现场参考，**不能**当恢复源）
  - `/tmp/recovered_v2.sql` + `/tmp/clean_db.sqlite`：第二次 .recover 产物，已灌回线上库
- 2026-09-14：PATCH /api/settings 写 comboStrategies 后 data.sqlite 再坏（malformed schema，`integrity_check` 报 btree 错误；第 4 次）。`.recover` 重建为 `/tmp/rebuilt_0914.sqlite`（integrity ok）后灌回恢复；`requestDetails.db` 未受影响。教训：该库写易坏，改 settings 优先走仪表盘/API，打完 PATCH 后立刻调 /api/usage/providers 验证；可疑时先 `PRAGMA integrity_check` 再写。

## 3. 请求链路（chat）

`/v1/chat/completions` → `handleChat` → 是否 combo：

- **combo 请求**：`getComboModels` 查库 → `handleComboChat` 逐个试模型
  - 轮询/粘滞：`comboRotationState`（round-robin + sticky）
  - 能力浮前：vision/pdf 等按请求自动排序，不丢模型
  - **失败记忆（本次新增）**：见 §4
- **单模型请求**：`handleSingleModelChat`，账号级 fallback（换账号重试）

Fusion 策略独立（并行问诊 + 裁判模型），本次未动。`compact.js` 有自己简版 combo 逻辑，未动。

## 4. Combo 失败记忆规则

实现：`open-sse/services/combo.js`（`comboHealthState`，key=`combo名::模型`）

| 失败类型 | 冷却 |
|---|---|
| 404 / 401 / 403 | 2 分钟；连续 ≥3 次 → 15 分钟 |
| 429（带上游 retry，如 "Try again in 31m"） | 上游时间，封顶 30 分钟；没带时间按 2 分钟 |
| 502 / 503 / 504 | 不记（走原有 5 秒等待逻辑） |
| 成功 | 清记录（自然半开恢复） |

入口自动跳过冷却中模型（日志 `skipping cooling models`）；**全员冷却时硬试**，不直接 503。combo 改名/改配置调 `resetComboRotation` 会同步清健康表。

## 5. 日常运维

```bash
cd ~/docker_workspace/9router
podman-compose up -d          # 启动
podman-compose down           # 停
podman-compose restart        # 重启
podman-compose build          # 重新构建镜像
podman ps --format "{{.Names}} {{.Status}} {{.Ports}}"   # 看齐
curl -s -m 8 localhost:20128/v1/models | head -c 200     # 健康
podman logs --tail 100 9router-local | grep -a COMBO     # 降级行为
```

machine 扩缩容（**停整个 VM，全容器闪断几分钟**，挑空闲做，先告知）：

```bash
podman machine stop podman-machine-default
podman machine set --memory 8192 --cpus 8
podman machine start podman-machine-default
podman-compose up -d
```

## 6. 发版流程（改代码 → 上线）

```bash
cd 9router-src   # 分支 feat/combo-health-fallback
# 1. 跑测试（宿主无依赖，用 builder 镜像跑）
podman build --target builder -t 9router:builder .
podman run --rm 9router:builder npx vitest run tests/unit/combo-*.test.js
# 2. 提交推送
git commit -am "..." && git push
# 3. 重新构建并重启（中断几秒）
#    前置：docker-compose.yml 的 9router 服务必须有 build 段
#    （context: ./9router-src；没它 compose build 会空跑返回成功，2026-09-14 已踩坑补上）
cd ~/docker_workspace/9router
podman-compose build
podman-compose up -d   # 镜像变了会自动删旧容器重建，无需手动 rm
# 4. 验证：curl /v1/models + 从 new-api 容器内 wget http://9router:20128/v1/models（应连通）
# 兜底：Hermes 有每 10 分钟的看门狗（9router-link-watchdog），别名丢了会自动重挂并通知
```

**回滚**：`podman-compose down`，`podman start 9router`（旧官方容器 + 同一份数据），秒回。

## 7. 已知事项

- `next build` 吃内存：2G machine 必 OOM，已扩到 8G；再犯看 `/tmp` 下构建日志尾部。
- `combo-autoswitch.test.js` 有 2 例在干净 master 上也挂（预存失败，与降级改动无关，别追）。
- 429/404 难自然复现：建临时 combo（一坏一好）打两枪，看 `cooling for Ns` + `skipping cooling models`，完事删 combo（2026-09-11 已验证过一轮，方法有效）。
- `docker-compose.yml` 含明文密码，不提交 git，不贴群里。
- 直写 SQLite 后应用侧可能延迟数分钟才可见（遇到过一次），改 combo 优先走仪表盘/API。
- new-api 容器有代理环境变量（7890），`9router` 已在 NO_PROXY 白名单；若改别名/加新内部域名，同步加白名单。

## 8. 仪表盘用量页（自建功能，非上游）

- 明细（Details）：Status 列 + Error 列（90px 固定宽，超长省略，悬停气泡看全文；成功显示 —）+ Account 列（connectionId 解析成名/邮箱，悬停看原 ID；无账号的显示 —）、失败行详情弹窗的红色 Error 原因（接口透出一句话摘要，原文仍脱敏）。
- 明细筛选：今天 / 24小时 / 7天 / 30天快捷（默认今天），手动改日期后高亮取消；Status 下拉（全部/成功/失败）；Error contains 关键字搜索（回车或失焦生效，后端 `data LIKE` 全字段匹配）。
- 明细筛选加 Combo 下拉（2026-09-14 新增；选项由 `getDistinctCombos()` 从 `requestDetails.comboName` 去重，随 `/api/usage/providers` 返回，后端等值过滤）。
- usage 页全宽（2026-09-14）：`DashboardLayout` 按路径豁免 `max-w-7xl`，只放开 `/dashboard/usage`（Overview/Details 一起变宽，其余页不动）；表格另去 `min-w`、Latency 压单行。
- 概览（Overview）：Health 卡（成功率 + 成功/失败/总数，随周期切换；下方小字"近 N 条内统计"，hover 说明保留窗口）；按模型/按账号表有成功/失败/健康度（=成功/总数）列，可排序。密钥/端点视图库里无对应字段，未加。
- Combos 页：顶部琥珀色冷却横条（有冷却才出现），显示冷却中模型 + 失败次数 + 上游状态码 + 恢复倒计时；数据来自新增接口 `GET /api/combos/health`（`getComboHealthSnapshot()` 快照内存 Map，不动降级逻辑）。
- 数据源：`requestDetails` 表（每请求一行，保留窗口由 observabilityMaxRecords 控制，线上实际 1000 条，长周期健康度只覆盖保留窗口）；列表接口打码，点 Detail 抽屉调新增 `GET /api/usage/request-details/[id]` 拿原文（同 dashboard 鉴权）。
- 流中断行（2026-09-14 新增）：客户端断连时回填占位行（status=error，response 标 `interrupted: true` + `client disconnected after Xms`，日志 `STREAM INTERRUPTED`），不再留 0 token 烂尾行；正常结束的 onStreamComplete 靠 `detailGuard` 互斥，先断连后到的完成回调直接丢弃。
- 429 冷却日志含解析输入（`retryAfter` + `errPreview` 前 120 字）：`cooling for 120s` 配空 errPreview = `clone().json()` 断了；errPreview 有文案但还是 120s = 正则对不上上游文案。
- 401 熔断已存在（`markAccountUnavailable` 锁 `modelLock_${model}` + `testStatus=unavailable`，providers 页标红），不需另做；Cline `Unauthorized: re-authenticate` = refreshToken 也废了，只能手动去 providers 页重绑。
- 429 双层冷却统一策略（2026-09-11 修）：账号层之前只指数退避（秒级），Cline 小时级窗口每 32 秒撞一次墙；现账号层/ combo 层都走 `parseUpstreamRetryMs`（accountFallback.js 导出，支持复合 `6h 37m`），有窗口按窗口封顶 30min，无窗口才指数退避。
- 锁粒度：`connectionId × model`（`modelLock_${model}` 写在单个 connection 记录上）。同账号其他模型、其他账号同模型都不受影响；combo 切到下一个模型继续。

## 9. 明细来源字段 comboName / requestedModel（2026-09-12 新增）

**解决什么**：之前明细只记最终落地的 provider/model，无法区分"哪个 combo 路由来的 / 客户端原始请求的 model"。

**字段语义**：

| 字段 | combo 请求 | 直连请求 |
|---|---|---|
| `comboName` | combo 名称 | null（前端显示 —，即"直连"） |
| `requestedModel` | 客户端原始 `body.model` | 客户端原始 `body.model` |
| `model`（原有） | 最终落地 provider/model | 最终落地 provider/model |

**落盘范围**：`requestDetails` 和 `usageHistory` 两表都加了这两列（`ALTER TABLE ADD COLUMN`，旧行为空，启动时 `syncSchemaFromTables` 会自动补列，无需手工迁移）。

**改动的 9 个文件**（分支 feat/combo-health-fallback，2026-09-13 已提交推送 `6acab207`，分支干净）：
- `src/lib/db/schema.js`：两表定义加列
- `src/lib/db/repos/requestDetailsRepo.js`：record 构建 + INSERT（9 列，含 comboName/requestedModel）
- `src/lib/db/repos/usageRepo.js`：INSERT（14 列）
- `open-sse/handlers/chatCore/requestDetail.js`：`buildRequestDetail` 输出字段
- `open-sse/handlers/chatCore/nonStreamingHandler.js`、`streamingHandler.js`、`sseToJsonHandler.js`、`chatCore.js`：8 个调用点透传
- `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`：明细表格加 Combo 列（Model 后）+ 详情抽屉加 Combo 行

## 10. SQLite 损坏与恢复（2026-09-12 两次事件，已根治）

**为什么之前总坏（根因已确认并修复）**：
- 损坏期间是 **WAL 模式**（`-journal_mode=wal`）。WAL 依赖 `-shm` 文件的 mmap 同步。
- **podman machine macOS 的 virtiofs bind mount 的 mmap 一致性有 bug**：容器进程和宿主机 sqlite3 CLI 各持一份 shm，页缓存互相打架 → 写坏。
- 修复：**已切换为 rollback journal 模式（`PRAGMA journal_mode=DELETE`）**。无 `-shm` 文件，宿主可直接查线上库，不会冲突。

**当前状态**：`journal_mode=delete`，宿主机可直接 `sqlite3 data.sqlite "SELECT ..."` 在线查，无需停容器或 cp 副本。

**恢复 SOP（保留，万一以后用 WAL 模式或碰坏）**：
```bash
# 1. 停容器（必须，防止继续写坏库）
podman stop 9router-local

# 2. 现场快照（不要覆盖旧快照）
cp data/db/data.sqlite data/db/data.sqlite.corrupt-$(date +%Y%m%d-%H%M%S)

# 3. 导出可救数据
sqlite3 data/db/data.sqlite ".recover" > /tmp/recovered.sql

# 4. 灌进新库并验证
sqlite3 /tmp/clean_db.sqlite < /tmp/recovered.sql
sqlite3 /tmp/clean_db.sqlite "PRAGMA integrity_check"   # 必须回 ok

# 5. 换库重启
mv data/db/data.sqlite data/db/data.sqlite.corrupt-again
cp /tmp/clean_db.sqlite data/db/data.sqlite
podman run -d --name 9router-local ...
```
