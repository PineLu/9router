# HANDOFF — 9Router 宿主机部署 + Combo 降级策略优化

> 最后更新：2026-09-16（分支干净，HEAD `2decee94`）
> 仓库：`https://github.com/PineLu/9router.git`（fork 自 decolua/9router）
> 本地源码：`/Users/qitmac001720/tujia_workspace/9router`（分支 `feat/combo-health-fallback`）
> 交接人：松林 ↔ AI 助手

---

## 项目背景

本机 9Router（本地 AI 网关）曾用官方镜像 `decolua/9router:latest` 跑，combo 降级策略太简单：无失败记忆，404 模型每个请求都先撞一遍。现已 fork 源码自部署，扩展了失败记忆、仪表盘、明细来源字段。

**2026-09-16 重大变更**：部署形态从 **podman 容器** 切换为 **宿主机源码直跑 + launchd 托管**，数据目录迁移到官方默认 `~/.9router`，容器版**彻底退役**。

## 当前状态（2026-09-16 更新，HEAD `2decee94` 已推送）

### 部署形态（现役）

- **运行方式**：宿主机源码直跑，**launchd 托管**（`~/Library/LaunchAgents/com.9router.local.plist`，Label `com.9router.local`），端口 `20128`
- **源码目录**：`~/tujia_workspace/9router`，分支 `feat/combo-health-fallback`，入口 `custom-server.js`
- **数据目录**：`~/.9router`（**官方默认目录**；plist 中已删除 `DATA_DIR`，源码不设即默认此目录）
- **日志**：`~/.9router/logs/9router-local.{out,err}.log`
- **容器版已完全退役**：容器 `9router-local`、镜像 `localhost/9router:local`、网络 `9router_9router-net`、老目录 `~/docker_workspace/9router/`（含 compose 与老源码）**均已删除，无回滚路径**
- **与 new-api 关系**：new-api 容器通过 `http://host.containers.internal:20128` 访问宿主机 9Router（渠道 1，已启用 status=1）

### 数据层

- SQLite，**rollback journal 模式**（`journal_mode=DELETE` + `synchronous=FULL` + `mmap_size=0`，已固化在 `src/lib/db/schema.js` 的 PRAGMA_SQL）
- 宿主机可直接 `sqlite3 ~/.9router/db/data.sqlite "SELECT ..."` 在线查，无需停服或 cp 副本
- 当前数据量：`requestDetails` 1000 行、`providerConnections` 7、`combos` 3

### 功能状态（已全部上线）

- **combo 降级策略**：404/401/403 冷却 2min、429 按上游窗口锁（封顶 30min）、5xx 不记，全员冷却硬试
- **仪表盘**：明细 Status/Error/Account/Combo 列、日期筛选、错误搜索、Health 卡、combos 页冷却横条
- **明细来源字段**：`requestDetails` 和 `usageHistory` 两表有 `comboName`（combo 路由标记，直连为 null）和 `requestedModel`（客户端原始 model）
- **DB 写入重试**：`SQLITE_BUSY`/`database is locked`/`disk I/O error` 退避重试 4 次（50/100/200/400ms）

### 当前 combo 配置

| combo | 说明 |
|---|---|
| `glm-5.3-flash` | 主用，round-robin，顺序 `[deepseek, step, z-ai]` |
| `combo-auto` | 顺序回退 |
| `ds-auto` | deepseek 自动 |

### 待办 / 注意

- **待办**：cl（cline-free）沉底或禁用（等用户拍板）；中断率监控（Error contains `client disconnected`）
- **`combo-autoswitch.test.js` 有 2 例预存失败**（与本次改动无关，别追）
- **`occline` provider 现无备用模型**：只留 `z-ai/glm-5.3-flash`，禁掉 444 个；遇 429（当日免费额度耗尽）即整条不可用
- **直写 SQLite 后**应用侧可能延迟才可见，改 combo 优先走仪表盘/API

---

## 部署流程（宿主机直跑）

```bash
cd ~/tujia_workspace/9router && git pull    # 拉最新代码
./9r-deploy.sh                              # 一键：install → build → 重启 → 验证
./9r-deploy.sh --skip-build                 # 跳过构建，只重启+验证（改 plist/数据时用）
```

脚本 `9r-deploy.sh`（仓库根）流程：
1. `npm install` + `npm run build`（在仓库根）
2. `launchctl kickstart -k gui/501/com.9router.local`（服务中断几秒）
3. 验证：launchd PID / 宿主机 `/v1/models` / new-api 跨容器访问 / `journal_mode=delete` / 日志无 malformed

**回滚**：容器版已删除，无秒回路径。若确需回退，见 `MAINTENANCE.md §7`。

## 验证命令

```bash
launchctl list | grep com.9router.local                    # 第一列=PID，第二列=0 为正常
curl -s -m 5 -H "Authorization: Bearer <key>" http://localhost:20128/v1/models | head -c 80
sqlite3 -readonly ~/.9router/db/data.sqlite "PRAGMA journal_mode;"   # 应回 delete
sqlite3 -readonly ~/.9router/db/data.sqlite "PRAGMA quick_check;"    # 应回 ok
tail -50 ~/.9router/logs/9router-local.out.log
# comboName 有值验证（有 combo 请求进来后）：
sqlite3 ~/.9router/db/data.sqlite \
  "SELECT comboName, requestedModel FROM requestDetails WHERE comboName IS NOT NULL LIMIT 5;"
```

## 目录结构（当前）

```
~/tujia_workspace/9router/          # fork 源码（git，分支 feat/combo-health-fallback）
├── 9r-deploy.sh                    # 一键发版脚本（构建 + launchd 重启 + 验证）
├── HANDOFF.md                      # 本文档
├── MAINTENANCE.md                  # 维护文档（排查/恢复/发版 SOP）
├── SYNC-GUIDE.md                   # 上游同步指南
└── src/ open-sse/ ...              # 源码

~/.9router/                         # 数据目录（官方默认，launchd 进程读写这里）
├── db/data.sqlite                  # rollback journal 模式，宿主机可直接查
├── auth/                           # 凭证
└── logs/9router-local.{out,err}.log

~/Library/LaunchAgents/com.9router.local.plist   # launchd 配置
```

## 技术方案摘要（已部署）

### A. Combo 降级策略
- `open-sse/services/combo.js`：`comboHealthState` Map，key=`combo名::模型`
- 冷却：404/401/403 → 2min（≥3 次 15min）；429 → 上游时间封顶 30min；5xx → 不记
- `handleComboChat` 三处接线：入口过滤冷却模型（全冷却硬试）/ 成功清除 / 失败记录
- 单测 `tests/unit/combo-health-fallback.test.js`（6 case，vitest）

### B. 仪表盘
- 明细 Status/Error/Account/Combo 列、日期筛选、错误关键字搜索
- 概览 Health 卡、按模型/账号表成功/失败/健康度
- Combos 页冷却横条（`GET /api/combos/health`）

### C. 明细来源字段 comboName/requestedModel
- **字段语义**：combo 请求 → comboName 有值，直连请求 → comboName 为空（前端显示"—"）；requestedModel 始终保存客户端原始 `body.model`
- **落盘范围**：`requestDetails` + `usageHistory` 两表加列（启动时 `syncSchemaFromTables` 自动 ALTER TABLE ADD COLUMN）
- **改动 9 文件**：schema.js、requestDetailsRepo.js、usageRepo.js、requestDetail.js、nonStreamingHandler.js、streamingHandler.js、sseToJsonHandler.js、chatCore.js、RequestDetailsTab.js

### D. SQLite 模式（治本）
- **rollback journal 模式**（`PRAGMA journal_mode=DELETE` + `synchronous=FULL` + `mmap_size=0`）
- 根因：podman machine macOS virtiofs bind mount 的 mmap 一致性有 bug，WAL 的 `-shm` 文件在容器进程和宿主机 sqlite3 CLI 之间页缓存互相打架 → 写坏（共 6 次）
- **关键教训**：只改运行时 `PRAGMA` 无效——源码 `schema.js` 写死 WAL，每次启动都会切回去。必须改源码才治本
- 切到宿主机直跑后，virtiofs 这一层彻底消失

## 上游 issue 对照（2026-09-14 查证）

- **#3488**（open）：`DISCONNECT: ResponseAborted` 导致 usage 行静默丢失。**本库已用 `detailGuard` 修掉**，且新增写入重试
- **#1692**（open）：投诉 `FETCH_CONNECT_TIMEOUT_MS=20s` / `STREAM_STALL_TIMEOUT_MS=30s` 过短——**本 fork 已是 60s/360s，且支持环境变量覆盖，不受影响**
- **#1393**（closed）：Codex 断连，靠 `CODEX_INITIAL_RESPONSE_TIMEOUT_MS` 修；该变量在本 fork 已不存在，补丁早已并入

## 中断排查结论（2026-09-14，未完全闭环）

- `client disconnected` 约占请求 1/3；非网关问题，是客户端（上游调用方）掐线
- `glm-5.3-flash` 侧：调用方是 new-api 的 `claude` token（cc-connect 飞书 bot / Claude SDK）。同一会话内 SDK 等首字 ~3-8s 超时就掐线重发（重发蹭缓存后成功）
- `muse-spark-1.3` 侧：`cl/cline-free` 免费路 429 抽风，oc 偶发 1s fast-fail，溢出到 deepseek 第三棒时客户端已掐线
- **结论**：142 条中断中 76 条 <9s，不可能由任何超时（最短 60s）触发 → 病根在客户端主动取消，非网关

## 变更回滚记录

- **2026-09-14 `b3549377`**：`client disconnected` 中断标记（`streamDetailGuard` / `detailGuard` / `streamHandler` 改动）**已全部回滚，与 master 一致**。原因：无法区分"真客户端 abort"与"下游 teardown / SDK 提前关闭"，把正常请求误报成中断，仪表盘数据不可信。**保留** compose 的三个上游超时环境变量、combo 逻辑、仪表盘改动、DB 写入重试
