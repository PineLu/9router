# HANDOFF — 9Router 源码部署 + Combo 降级策略优化

> 最后更新：2026-09-13（分支干净，HEAD `6acab207`；comboName/requestedModel 9 文件已提交推送；.snap 废弃快照已删）
> 仓库：`https://github.com/PineLu/9router.git`（fork 自 decolua/9router）
> 本地源码：`/Users/qitmac001720/docker_workspace/9router/9router-src`
> 交接人：松林 ↔ AI 助手

---

## 项目背景

本机 9Router（本地 AI 网关，podman 容器）曾用官方镜像 `decolua/9router:latest` 跑，combo 降级策略太简单：无失败记忆，404 模型每个请求都先撞一遍。现已 fork 源码自部署，扩展了失败记忆、仪表盘、明细来源字段。

## 当前状态（2026-09-14 更新，HEAD `4a86ad06` 已推送）

- **源码已就位**：`~/docker_workspace/9router/9router-src`，分支 `feat/combo-health-fallback`，HEAD `4a86ad06`（2026-09-14 大版本已提交推送）
- **现役容器 `9router-local` 已 Up**（自建镜像 `localhost/9router:local`，20128，数据 bind mount `~/docker_workspace/9router/data`）
- **数据层**：SQLite，**rollback journal 模式**（已从 WAL 切出，无 `-shm`，宿主机可直接查库不冲突）
- **combo 降级策略已上线**：404/401/403 冷却 2min、429 按上游窗口锁、5xx 不记，全员冷却硬试
- **仪表盘已上线**：明细 Status/Error/Account/Combo 列、日期筛选、错误搜索、Health 卡、combos 页冷却横条
- **明细来源字段已上线**：`requestDetails` 和 `usageHistory` 两表新增 `comboName`（combo 路由标记，直连为 null）和 `requestedModel`（客户端原始 model），覆盖非流式/流式/SSE-JSON 共 8 个调用路径
- **comboName 写 bug 已修复**：之前调用点读 `body?.comboName`（body 里没有该字段 → 全落 null），已改为从函数参数读取。修复已随最新镜像上线
- **podman machine**：6C/8G/100G（2026-09-13 实测 `podman machine list`；旧文档写 8C 已纠正），容器 restart=unless-stopped 自愈

### 2026-09-14 会话增量（已上线，随 `4a86ad06`）

1. **仪表盘**：usage 页全宽（`DashboardLayout` 按 `/dashboard/usage` 路径豁免 `max-w-7xl`）、表格去 min-w 自适应、Latency 压单行、筛选加 Combo 下拉（`getDistinctCombos()`）
2. **详情原文**：新增 `GET /api/usage/request-details/[id]`（dashboard 鉴权），抽屉点开拉全文；列表接口保持脱敏
3. **Fallback 选择 bug**：`combos/page.js` 选 Fallback 曾被当默认删条目 → 实际跑全局 round-robin。已改为显式写 `fallbackStrategy:"fallback"`；存量 `muse-spark-1.3` 已修正
4. **流中断回填**：客户端断连时占位行回填 `status=error` + `client disconnected after Xms (ResponseAborted)`，`detailGuard` 互斥防晚到完成回调覆盖；日志 `STREAM INTERRUPTED`
5. **compose 构建修复**：`docker-compose.yml` 补 `build.context=./9router-src`（此前 compose build 空跑返回成功）；镜像变了 `up -d` 会自动重建容器
6. **data.sqlite 第 4 次损坏与恢复**：PATCH settings 后再次 malformed；`.recover` 重建 `/tmp/rebuilt_0914.sqlite` 灌回恢复，`requestDetails.db` 未受影响；损坏现场 `data.sqlite.corrupt-20260914-1330`
7. **combo 排序调整（用户已确认）**：`glm-5.3-flash` 重排为 `[deepseek, step, z-ai]`（原 z-ai 首位 TTFT~13s，重排后其中断归零）；**`muse-spark-1.3` 用户明确要求不动**
8. **DB 写入重试**（`396fac70`）：`requestDetailsRepo.flushToDatabase` 遇 `SQLITE_BUSY`/`database is locked`/`disk I/O error` 退避重试 4 次（50/100/200/400ms），其余错误不重试。此前批量写失败即整批丢弃（对应上游 9router#3488 的"usage 行静默丢失"）
9. **上游超时显式固化**（`396fac70`）：compose 写死 `STREAM_FIRST_CHUNK_TIMEOUT_MS=200000` / `STREAM_STALL_TIMEOUT_MS=360000` / `FETCH_CONNECT_TIMEOUT_MS=60000`（与代码默认一致，纯为可调性；改值重启即可，无需重建）

### 上游 issue 对照（2026-09-14 查证）

- **#3488**（open）：`DISCONNECT: ResponseAborted` 导致 usage 行静默丢失，作者日志 `⚡ DISCONNECT: ResponseAborted · opencode/hy3-free · 2255ms` 与本库中断行同源；作者结论"agentic CLI 客户端激进取消流"。**本库已用 `detailGuard` 修掉丢失问题**，且新增写入重试
- **#1692**（open）：投诉 `FETCH_CONNECT_TIMEOUT_MS=20s` / `STREAM_STALL_TIMEOUT_MS=30s` 过短——**本 fork 已是 60s/360s，且支持环境变量覆盖，不受影响**
- **#1393**（closed）：Codex 断连，靠 `CODEX_INITIAL_RESPONSE_TIMEOUT_MS` 修；该变量在本 fork 已不存在，补丁早已并入
- **结论**：9router 侧超时类隐患上游已修净；本库 142 条中断中 76 条 <9s，不可能由任何超时（最短 60s）触发 → 病根在客户端主动取消，非网关

### 中断排查结论（2026-09-14，未完全闭环）

- `client disconnected` 约占请求 1/3；非网关问题，是客户端（上游调用方）掐线
- `glm-5.3-flash` 侧：调用方是 new-api 的 `claude` token（cc-connect 飞书 bot / Claude SDK）。同一会话内 claude-code SDK 等首字 ~3-8s 超时就掐线重发（重发蹭缓存后成功）；cc-connect 日志对掐线零感知。deepseek 中断 22 次全是 combo 尝试行（第三棒接锅），根因在 muse 慢/前两棒拖时
- `muse-spark-1.3` 侧：`cl/cline-free` 免费路 429 抽风（当日额度反复横跳），oc 偶发 1s fast-fail，溢出到 deepseek 第三棒时客户端已掐线；用户确认 muse 排序不动
- **待办**：cl 沉底/禁用（等用户拍板）；中断率监控（Error contains `client disconnected`）

## 目录结构（当前）

```
~/docker_workspace/9router/
├── 9router-src/          # fork 源码（git，分支 feat/combo-health-fallback）
├── data/                 # 9Router 数据（SQLite/auth/logs），现役容器 bind mount 指向这里
│   └── db/data.sqlite    # rollback journal 模式（无 -wal/-shm），宿主机可直接查
├── docker-compose.yml    # 现役容器的编排（含明文 INITIAL_PASSWORD，勿提交 git）
├── docker-compose.yml.bak
├── HANDOFF.md            # 本文档
└── MAINTENANCE.md        # 维护文档（排查/恢复/发版 SOP）
```

## 技术方案摘要（已部署）

### A. Combo 降级策略（T2，已上线）
- `open-sse/services/combo.js`：`comboHealthState` Map，key=`combo名::模型`
- 冷却：404/401/403 → 2min（≥3 次 15min）；429 → 上游时间封顶 30min；5xx → 不记
- `handleComboChat` 三处接线：入口过滤冷却模型（全冷却硬试）/ 成功清除 / 失败记录
- 单测 `tests/unit/combo-health-fallback.test.js`（6 case，vitest）

### B. 仪表盘（已上线）
- 明细 Status 列 + Error 列 + Account 列 + Combo 列、日期筛选、错误关键字搜索
- 概览 Health 卡、按模型/账号表成功/失败/健康度
- Combos 页冷却横条（`GET /api/combos/health`）

### C. 明细来源字段 comboName/requestedModel（已上线）
- **字段语义**：combo 请求 → comboName 有值，直连请求 → comboName 为空（前端显示"—"）；requestedModel 始终保存客户端原始 `body.model`
- **落盘范围**：`requestDetails` + `usageHistory` 两表加列（启动时 `syncSchemaFromTables` 自动 ALTER TABLE ADD COLUMN）
- **改动 9 文件**：schema.js、requestDetailsRepo.js、usageRepo.js、requestDetail.js（buildRequestDetail 函数）、nonStreamingHandler.js、streamingHandler.js、sseToJsonHandler.js、chatCore.js、RequestDetailsTab.js
- **代码已修**：comboName 从 `handleChatCore` 的函数参数读取（通过 sharedCtx 透传到子 handler），不再从 body 读

### D. SQLite 模式变更（已上线）
- 从 WAL 模式切回 **rollback journal 模式**（`PRAGMA journal_mode=DELETE`）
- 根因：podman machine macOS virtiofs bind mount 的 mmap 一致性有 bug，WAL 的 `-shm` 文件在容器进程和宿主机 sqlite3 CLI 之间页缓存互相打架 → 写坏
- 修复后：宿主机可直接 `sqlite3 data.sqlite "SELECT ..."` 在线查，无需停容器或 cp 副本
- 代价：个人网关并发写入极低，完全无感知

## 部署流程（统一走 podman-compose，与 MAINTENANCE §6 一致）

```bash
cd ~/docker_workspace/9router/9router-src
git branch --show-current   # 应为 feat/combo-health-fallback

# 发版：分支干净时直接 build → up（中断几秒）；有改动先 commit+push
cd ~/docker_workspace/9router
podman-compose build && podman-compose up -d
```

> 别用裸 `podman build/run`：compose 里带了 `new-api_new-api-network` 别名 `9router`，裸重建会丢别名导致 new-api 连不上（有看门狗 9router-link-watchdog 自动重挂兜底，但别主动踩）。

回滚：删新容器，`podman start 9router`（旧官方容器 + 同一份数据），秒回。

## 验证命令

```bash
podman ps --format "{{.Names}} {{.Status}}"
curl -s http://localhost:20128/v1/models | head -c 120
sqlite3 ~/docker_workspace/9router/data/db/data.sqlite "PRAGMA journal_mode;"   # 应回 delete
sqlite3 ~/docker_workspace/9router/data/db/data.sqlite "PRAGMA integrity_check;"  # 应回 ok
# comboName 有值验证（有 combo 请求进来后）：
sqlite3 ~/docker_workspace/9router/data/db/data.sqlite \
  "SELECT comboName, requestedModel FROM requestDetails WHERE comboName IS NOT NULL LIMIT 5;"
```

## 已知事项

- **数据库**：rollback journal 模式，可直接查线上库。**不要再切回 WAL**。
- **podman machine**：6C/8G/100G（2026-09-13 实测；旧文档写 8C 已纠正），停/启 = 全部容器闪断，挑空闲操作
- **new-api 别名**：`9router-local` 挂 `new-api_new-api-network` 别名 `9router`，渠道 BaseURL `http://9router:20128`。每次重建容器必须重挂别名，且别名需在 new-api NO_PROXY 白名单
- **`docker-compose.yml`** 含明文密码，不提交 git，不贴群里
- **直写 SQLite 后**：应用侧可能延迟数分钟才可见（长 WAL 读 cache），改 combo 优先走仪表盘/API
- **构建**：`next build` 吃内存，machine 已扩到 8G 无压力。builder 镜像有 cache，重 build 秒过
- **单测**：`npx vitest run tests/unit/combo-health-fallback.test.js` 通过
- **`combo-autoswitch.test.js` 有 2 例预存失败**（与本次改动无关，别追）
- **模型禁用（disabledModels）**：按 provider alias 存 `kv(scope='disabledModels')`，经 `POST/DELETE /api/models/disabled` 维护，只隐藏不删配置。2026-09-14 清理了 `occline`（=`openai-compatible-chat-4f2e6269`，github+google 两账号，上游 445 个模型）→ **只留 `z-ai/glm-5.3-flash`，禁掉 444 个**。恢复单个：`DELETE /api/models/disabled?providerAlias=occline&id=<模型ID>`。注意该 provider 现无备用模型，glm-5.3-flash 遇 429（当日免费额度耗尽）即整条不可用

## 变更回滚记录

- **2026-09-14 `b3549377`**：`client disconnected` 中断标记（`streamDetailGuard` / `detailGuard` / `streamHandler` 改动）**已全部回滚，与 master 一致**。原因：无法区分"真客户端 abort"与"下游 teardown / SDK 提前关闭"，把正常请求误报成中断，仪表盘数据不可信。**保留** compose 的三个上游超时环境变量、combo 逻辑、仪表盘改动、DB 写入重试。历史 error 行未清理。

## 待办

- T1+T2+仪表盘+429+comboName/requestedField 已全部上线，无阻塞项
- T3（合回 master）已取消：自用分支不合 master
- 可选：定期 `PRAGMA integrity_check` 挂 cron（目前还没挂，rollback 模式下极低概率再坏）
- 可选：把 observabilityMaxRecords 从 1000 降下来减小写放大
