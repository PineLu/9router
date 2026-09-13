# HANDOFF — 9Router 源码部署 + Combo 降级策略优化

> 最后更新：2026-09-13（分支干净，HEAD `6acab207`；comboName/requestedModel 9 文件已提交推送；.snap 废弃快照已删）
> 仓库：`https://github.com/PineLu/9router.git`（fork 自 decolua/9router）
> 本地源码：`/Users/qitmac001720/docker_workspace/9router/9router-src`
> 交接人：松林 ↔ AI 助手

---

## 项目背景

本机 9Router（本地 AI 网关，podman 容器）曾用官方镜像 `decolua/9router:latest` 跑，combo 降级策略太简单：无失败记忆，404 模型每个请求都先撞一遍。现已 fork 源码自部署，扩展了失败记忆、仪表盘、明细来源字段。

## 当前状态（2026-09-13 快照，分支干净）

- **源码已就位**：`~/docker_workspace/9router/9router-src`，分支 `feat/combo-health-fallback`，HEAD `6acab207`（comboName/requestedModel 已提交推送）
- **现役容器 `9router-local` 已 Up**（自建镜像 `localhost/9router:local`，20128，数据 bind mount `~/docker_workspace/9router/data`）
- **数据层**：SQLite，**rollback journal 模式**（已从 WAL 切出，无 `-shm`，宿主机可直接查库不冲突）
- **combo 降级策略已上线**：404/401/403 冷却 2min、429 按上游窗口锁、5xx 不记，全员冷却硬试
- **仪表盘已上线**：明细 Status/Error/Account/Combo 列、日期筛选、错误搜索、Health 卡、combos 页冷却横条
- **明细来源字段已上线**：`requestDetails` 和 `usageHistory` 两表新增 `comboName`（combo 路由标记，直连为 null）和 `requestedModel`（客户端原始 model），覆盖非流式/流式/SSE-JSON 共 8 个调用路径
- **comboName 写 bug 已修复**：之前调用点读 `body?.comboName`（body 里没有该字段 → 全落 null），已改为从函数参数读取。修复已随最新镜像上线
- **podman machine**：6C/8G/100G（2026-09-13 实测 `podman machine list`；旧文档写 8C 已纠正），容器 restart=unless-stopped 自愈

## 目录结构（当前）

```
~/docker_workspace/9router/
├── 9router-src/          # fork 源码（git，分支 feat/combo-health-fallback，干净，1 个 untracked snapshot）
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

## 待办

- T1+T2+仪表盘+429+comboName/requestedField 已全部上线，无阻塞项
- T3（合回 master）已取消：自用分支不合 master
- 可选：定期 `PRAGMA integrity_check` 挂 cron（目前还没挂，rollback 模式下极低概率再坏）
- 可选：把 observabilityMaxRecords 从 1000 降下来减小写放大
