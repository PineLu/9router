# 9Router 维护文档

> 更新：2026-09-16 | 现状：**宿主机源码直跑 + launchd 托管**；数据目录 `~/.9router`；容器版已彻底退役；SQLite rollback journal 模式

## 1. 架构总览

```
客户端（Claude Code / cc-connect / Cline 等）
  │  localhost:20128  (OpenAI 兼容 /v1/*)
  ▼
9Router（宿主机 node 进程，launchd 托管 com.9router.local）
  ├─ Next.js 仪表盘（Web UI、combo/渠道配置）
  └─ open-sse 网关（/v1/chat、/v1/models 等实际转发逻辑）
        │  按 combo 配置扇出到各 provider 账号
        ▼
上游 providers（cline / codebuddy-cn / codebuddy-intl / openai-compatible 节点…）
```

同机另有三个独立容器（podman，与 9Router 无依赖，给 new-api 业务用）：

| 容器 | 镜像 | 端口 | 说明 |
|---|---|---|---|
| new-api | calciumion/new-api | 3003→3000 | 计费/中转；渠道 1 以 `http://host.containers.internal:20128` 接回本网关（走 podman 内置域名，非容器网络别名） |
| redis | redis:8-alpine | 6379（未映射宿主） | new-api 缓存 |
| postgres | postgres:15 | 15432→5432 | new-api 数据库（数据在 `~/docker_workspace/new-api/postgres_data`，勿动） |

底层：podman machine（applehv，6C / 8G / 100G）。

> **历史**：2026-09-16 前 9Router 跑在容器 `9router-local`（自建镜像 `localhost/9router:local`）里，因 **virtiofs + WAL 反复损坏 SQLite**（6 次）而改为宿主机直跑。容器、镜像、网络、老目录均已删除。

## 2. 数据与源码位置

- **网关数据**：`~/.9router`（官方默认目录）
  - `db/data.sqlite`：渠道、combo、API key（SQLite，rollback journal 模式）
  - `auth/`：凭证
  - `logs/9router-local.{out,err}.log`：运行日志
- **源码**：`~/tujia_workspace/9router`，分支 `feat/combo-health-fallback`
- **launchd 配置**：`~/Library/LaunchAgents/com.9router.local.plist`
- **发版脚本**：`~/tujia_workspace/9router/9r-deploy.sh`
- **构建日志**：`/tmp/9r-deploy-<时间戳>.log`

### 为什么数据目录是 `~/.9router`

源码里 `DATA_DIR` 是**可选覆盖项**（`src/lib/dataDir.ts`、`src/mitm/paths.js`）：不设该变量时默认就是 `~/.9router`。迁移后 plist 中**已删除 `DATA_DIR`**，走默认值。

## 3. 请求链路（chat）

`/v1/chat/completions` → `handleChat` → 是否 combo：

- **combo 请求**：`getComboModels` 查库 → `handleComboChat` 逐个试模型
  - 轮询/粘滞：`comboRotationState`（round-robin + sticky）
  - 能力浮前：vision/pdf 等按请求自动排序，不丢模型
  - **失败记忆**：见 §4
- **单模型请求**：`handleSingleModelChat`，账号级 fallback（换账号重试）

Fusion 策略独立（并行问诊 + 裁判模型）。`compact.js` 有自己简版 combo 逻辑。

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
# 服务管理（launchd）
launchctl kickstart -k gui/501/com.9router.local                   # 重启
launchctl unload ~/Library/LaunchAgents/com.9router.local.plist    # 停
launchctl load   ~/Library/LaunchAgents/com.9router.local.plist    # 起
launchctl list | grep com.9router.local                            # 看状态（第一列=PID，第二列=0 正常）

# 健康检查
curl -s -m 5 http://localhost:20128/v1/models | head -c 120
sqlite3 -readonly ~/.9router/db/data.sqlite "PRAGMA quick_check;"   # 应回 ok
tail -100 ~/.9router/logs/9router-local.out.log

# 跨容器连通（new-api → 宿主机 9Router）
/opt/homebrew/bin/podman exec new-api wget -q -O- -T 5 \
  --header "Authorization: Bearer <key>" http://host.containers.internal:20128/v1/models | head -c 60
```

> ⚠️ **plist 只在 load 时读取**：改完 plist 必须 `unload` + `load` 才生效，热改无效（2026-09-16 踩过）。

## 6. 发版流程（改代码 → 上线）

```bash
cd ~/tujia_workspace/9router
git pull                        # 拉最新
./9r-deploy.sh                  # 一键：npm install → npm run build → launchctl 重启 → 验证
./9r-deploy.sh --skip-build     # 跳过构建，只重启+验证
```

脚本自动验证 5 项：launchd PID / 宿主机 `/v1/models` / new-api 跨容器访问 / `journal_mode=delete` / 日志无 `malformed`。全绿才 exit 0。

> 别用裸 `node custom-server.js` 手起：会和 launchd 进程抢 20128 端口（`EADDRINUSE`）。

## 7. 回滚 / 应急

**容器版已彻底退役，无秒回路径。** 若确需回退到容器：

```bash
# 1) 从源码重建镜像（老 compose 已随目录删除，需自己写）
cd ~/tujia_workspace/9router
/opt/homebrew/bin/podman build -t localhost/9router:local .

# 2) 起容器时必须挂 ~/.9router（否则空库），并停掉宿主机进程（抢端口）
launchctl unload ~/Library/LaunchAgents/com.9router.local.plist
/opt/homebrew/bin/podman run -d --name 9router-local -p 20128:20128 \
  -v ~/.9router:/app/data -e DATA_DIR=/app/data -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 -e NODE_ENV=production localhost/9router:local
```

> ⚠️ 容器与宿主机进程**不能同时跑**（抢 20128）；且容器内 WAL 会损坏 DB（见 §8），回退后务必确认 `journal_mode=delete`。

## 8. SQLite 损坏史与恢复

**为什么之前总坏（根因已确认并根治）**：
- 损坏期间是 **WAL 模式**（`journal_mode=wal`）。WAL 依赖 `-shm` 文件的 mmap 同步
- **podman machine macOS 的 virtiofs bind mount 的 mmap 一致性有 bug**：容器进程和宿主机 sqlite3 CLI 各持一份 shm，页缓存互相打架 → 写坏（共 6 次）
- **根因二**：源码 `src/lib/db/schema.js` 的 PRAGMA_SQL 写死 `journal_mode = WAL`，每次容器启动都把库切回 WAL。**只改运行时 PRAGMA 无效，必须改源码**

**修复**：
1. 源码 PRAGMA_SQL 改为 `journal_mode=DELETE` + `synchronous=FULL` + `mmap_size=0`（已固化）
2. 切换宿主机直跑，virtiofs 这层彻底消失
3. 清理 `.recover` 遗留的 `lost_and_found` 残表（会干扰页管理）

**恢复 SOP（万一再坏）**：
```bash
# 1. 停服务（必须，防止继续写坏库）
launchctl unload ~/Library/LaunchAgents/com.9router.local.plist

# 2. 现场快照三件套（只拷主文件会丢最近写入）
cp ~/.9router/db/data.sqlite{,-wal,-shm} /tmp/backup-$(date +%Y%m%d-%H%M%S)/

# 3. 导出可救数据（用 .recover，不要用 .dump！）
#    .dump 遇 CORRUPTION ERROR 会生成 "ROLLBACK; -- due to errors" 导致整个导入回滚（0 字节库）
sqlite3 ~/.9router/db/data.sqlite ".recover" > /tmp/recovered.sql
# 过滤 lost_and_found 残表（否则会灌回线上干扰页管理）：
grep -vE "^(INSERT (OR IGNORE )?INTO '?lost_and_found|CREATE TABLE (IF NOT EXISTS )?lost_and_found)" \
  /tmp/recovered.sql > /tmp/recovered.clean.sql

# 4. 灌进新库并验证
sqlite3 /tmp/clean_db.sqlite < /tmp/recovered.clean.sql
sqlite3 /tmp/clean_db.sqlite "PRAGMA integrity_check;"   # 必须回 ok
sqlite3 /tmp/clean_db.sqlite "PRAGMA journal_mode=DELETE;"

# 5. 换库重启
mv ~/.9router/db/data.sqlite ~/.9router/db/data.sqlite.corrupt-$(date +%Y%m%d-%H%M%S)
cp /tmp/clean_db.sqlite ~/.9router/db/data.sqlite
launchctl load ~/Library/LaunchAgents/com.9router.local.plist
```

## 9. 仪表盘用量页（自建功能，非上游）

- 明细（Details）：Status 列 + Error 列（90px 固定宽，超长省略，悬停气泡看全文）+ Account 列（connectionId 解析成名/邮箱）+ Combo 列
- 明细筛选：今天 / 24小时 / 7天 / 30天快捷（默认今天）；Status 下拉；Error contains 关键字搜索（后端 `data LIKE` 全字段匹配）；Combo 下拉（`getDistinctCombos()` 从 `requestDetails.comboName` 去重）
- usage 页全宽：`DashboardLayout` 按路径豁免 `max-w-7xl`，只放开 `/dashboard/usage`
- 概览（Overview）：Health 卡（成功率 + 成功/失败/总数）；按模型/按账号表有成功/失败/健康度列，可排序
- Combos 页：顶部琥珀色冷却横条，显示冷却中模型 + 失败次数 + 上游状态码 + 恢复倒计时；数据来自 `GET /api/combos/health`
- 数据源：`requestDetails` 表（保留窗口由 observabilityMaxRecords 控制，线上实际 1000 条）
- 详情抽屉调 `GET /api/usage/request-details/[id]` 拿原文（同 dashboard 鉴权）

## 10. 明细来源字段 comboName / requestedModel

**解决什么**：之前明细只记最终落地的 provider/model，无法区分"哪个 combo 路由来的 / 客户端原始请求的 model"。

**字段语义**：

| 字段 | combo 请求 | 直连请求 |
|---|---|---|
| `comboName` | combo 名称 | null（前端显示 —，即"直连"） |
| `requestedModel` | 客户端原始 `body.model` | 客户端原始 `body.model` |
| `model`（原有） | 最终落地 provider/model | 最终落地 provider/model |

**落盘范围**：`requestDetails` 和 `usageHistory` 两表都加了这两列（`ALTER TABLE ADD COLUMN`，旧行为空，启动时 `syncSchemaFromTables` 自动补列）。

**改动的 9 个文件**：
- `src/lib/db/schema.js`：两表定义加列
- `src/lib/db/repos/requestDetailsRepo.js`：record 构建 + INSERT（9 列）
- `src/lib/db/repos/usageRepo.js`：INSERT（14 列）
- `open-sse/handlers/chatCore/requestDetail.js`：`buildRequestDetail` 输出字段
- `open-sse/handlers/chatCore/{nonStreamingHandler,streamingHandler,sseToJsonHandler,chatCore}.js`：8 个调用点透传
- `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`：明细表格加 Combo 列 + 详情抽屉加 Combo 行

## 11. 已知事项

- `next build` 吃内存：宿主机 32G 无压力
- `combo-autoswitch.test.js` 有 2 例在干净 master 上也挂（预存失败，与降级改动无关，别追）
- 429/404 难自然复现：建临时 combo（一坏一好）打两枪，看 `cooling for Ns` + `skipping cooling models`，完事删 combo
- **仓库根的 `docker-compose.yml` 是上游自带的**（decolua 官方镜像版），非我们自建的容器编排；我们那份含明文密码的 compose 已随老目录删除
- 直写 SQLite 后应用侧可能延迟才可见，改 combo 优先走仪表盘/API
- 429 双层冷却统一策略：账号层/ combo 层都走 `parseUpstreamRetryMs`（支持复合 `6h 37m`），有窗口按窗口封顶 30min，无窗口才指数退避
- 锁粒度：`connectionId × model`（`modelLock_${model}` 写在单个 connection 记录上）。同账号其他模型、其他账号同模型都不受影响
