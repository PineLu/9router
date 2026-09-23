# 9Router Fork 同步与开发指南

> 本文档记录如何从上游仓库同步更新到 fork 仓库，如何合并上游更新到本地开发分支，
> 以及当前开发分支的功能说明和运行方式。

---

## 目录

1. [仓库关系](#1-仓库关系)
2. [同步上游仓库到 Fork](#2-同步上游仓库到-fork)
3. [合并上游更新到开发分支](#3-合并上游更新到开发分支)
4. [修复合并冲突](#4-修复合并冲突)
5. [构建与运行](#5-构建与运行)
6. [当前开发分支功能说明](#6-当前开发分支功能说明)
7. [常用命令速查](#7-常用命令速查)

---

## 1. 仓库关系

```
上游仓库 (upstream)      你的 Fork (origin)         本地开发分支
decolua/9router    →    PineLu/9router      →    feat/combo-health-fallback
     ↑                       ↑                        ↑
   官方代码              同步后的 fork           魔改 + 合并上游
```

**远程仓库配置：**

```bash
origin    git@github.com:PineLu/9router.git      # 你的 fork
upstream  git@github.com:decolua/9router.git     # 上游官方
```

**本地路径：** `~/tujia_workspace/9router`

**分支说明：**

| 分支 | 用途 |
|---|---|
| `master` | 跟踪上游，保持干净（当前 `39e36d3d` / v0.5.86，与 upstream/master 一致） |
| `feat/combo-health-fallback` | 开发分支，所有魔改都在这里（领先提交数用 `git rev-list --count master..feat/combo-health-fallback` 动态查询） |

> ⚠️ **开发分支不合并回 master**（自用分支，见 §6 说明）。

### 1.1 分支职责与发布原则

固定约定：

```text
master
= 纯上游跟踪分支
= 只用于同步 / baseline 对比
= 不用于发布当前自定义版本

sync-upstream-*
= 临时上游同步与冲突验证分支
= 通过回归后合入 feat/combo-health-fallback
= 不作为正式发布分支

feat/combo-health-fallback
= 当前自定义生产 / 自用发布分支
= 所有已验收的 fork 定制和上游同步最终都落在这里
= 构建、部署、发布必须从此分支执行
```

发布前必须先确认：

```bash
cd ~/tujia_workspace/9router
git fetch origin
git checkout feat/combo-health-fallback
git pull --ff-only origin feat/combo-health-fallback

git status
git rev-parse HEAD
git rev-parse origin/feat/combo-health-fallback
```

要求：

- 工作区 clean。
- 本地 HEAD 与 `origin/feat/combo-health-fallback` 一致。
- 不从 `master` 发布自定义版本，否则会丢失 fork 定制。
- 不从 `sync-upstream-*` 发布；该类分支只用于同步验证。
- 上游同步必须先在临时 sync 分支完成冲突处理、定向测试、full-unit baseline 差集、build 和 deploy smoke，全部通过后再合回正式发布分支。

**2026-09-23 当前正式发布基线：**

```text
feat/combo-health-fallback
d855b86c0a2556a08bee692235f1429d9856b595
```

该基线包含 upstream v0.5.86、所有现有 fork 定制、CodeBuddy `403/code=11140` request-safety 分类修复、Combo Fallback strategy 修复。后续若仅有文档提交，分支 HEAD 可以高于此 SHA；构建发布时仍以远端 `feat/combo-health-fallback` 最新已验收 HEAD 为准。

后续发布依然：

```bash
git checkout feat/combo-health-fallback
git pull --ff-only origin feat/combo-health-fallback
./9r-deploy.sh
```


---

## 2. 同步上游仓库到 Fork

### 2.1 添加 upstream 远程仓库（首次）

```bash
cd ~/tujia_workspace/9router
git remote add upstream git@github.com:decolua/9router.git
```

> 检查是否已配置：`git remote -v`

### 2.2 拉取上游最新代码

```bash
# 拉取上游所有分支和标签
git fetch upstream

# 切到 master 分支并合并上游
git checkout master
git merge upstream/master
```

### 2.3 推送到你的 Fork

```bash
git push origin master
```

> **注意：** 每次上游有更新时，重复以上步骤即可。

---

## 3. 合并上游更新到开发分支

### 3.1 切到开发分支

```bash
git checkout feat/combo-health-fallback
```

### 3.2 合并上游 master

```bash
git merge upstream/master
```

如果出现冲突，需要手动解决（见第 4 节）。

> **建议**：上游更新频繁时，可先建一个临时同步分支（如 `sync-upstream-0922-v0.5.85`）合并上游，
> 解决完冲突再合入开发分支，避免直接污染开发分支历史。

### 3.3 推送到 Fork

```bash
git push origin feat/combo-health-fallback
```

### 3.4 合并后必须验证

```bash
cd ~/tujia_workspace/9router
./9r-deploy.sh          # 构建 + 重启 + 5 项验证
```

**关键回归点**（上游合并最容易冲掉的自定义改动）：

| 改动 | 文件 | 验证方式 |
|---|---|---|
| SQLite PRAGMA（DELETE 模式） | `src/lib/db/schema.js` | 部署后 `PRAGMA journal_mode` 应为 `delete` |
| combo 失败记忆 | `open-sse/services/combo.js` | 看日志有无 `skipping cooling models` |
| comboName/requestedModel 字段 | schema.js + 4 个 handler + 2 个 repo | 查库 `SELECT comboName FROM requestDetails` |
| 仪表盘 Combo 列/筛选 | `RequestDetailsTab.js` 等 | 打开 `/dashboard/usage` 看列是否还在 |

---

## 4. 修复合并冲突

### 4.1 历史冲突记录

**2026-09-16 同步（`v0.5.75` → 上游 master `17c4cc76`）**

上游新增（可能与本 fork 冲突）：
- `feat(claude-code): drive auto-compact window, add a 1M-context toggle`
- `feat(xiaomi-mimo): merge MiMo Desktop support into xiaomi-mimo as dual auth`

> 本次同步的冲突与解决方式在此记录（尚未执行同步，待补充）。

### 4.1.1 2026-09-22 同步记录（v0.5.81 → v0.5.85）

- 上游：`a8c9d380` → `21583c03`
- 新增：37 commits / 135 files
- 临时分支：`sync-upstream-0922-v0.5.85`
- 核心双父 merge：`844ab841`
- 同步后修复：`0674530d`（恢复 `sseToJsonHandler.js` 的 content-filter import）
- 与 fork 自定义改动重叠：8 files
- 重点融合：
  - `chatCore.js` / `nonStreamingHandler.js` / `sseToJsonHandler.js`：保留 `comboName/requestedModel`、refusal 语义，同时接入 OpenCode fingerprint、Qoder status 等上游改动
  - `combos/page.js`：保留 cooling banner，同时接入 presets / bulk / capability 聚合
  - `usageRepo.js` / `UsageStats.js` / `OverviewCards.js`：保留 attribution/Health，同时接入 All Time、Requests、provider/model breakdown 和 2-day lastUsed 优化
- 验证结果：
  - v0.5.85 upstream-targeted：216 passed / 0 failed
  - fork core：79 passed / 0 failed
  - DB reliability：5/5 PASS
  - merged-file focused：91 passed / 0 failed
  - full unit：sync 78 failed vs master 79 failed
  - NEW REGRESSIONS = 0；FIXED = 1
  - build EXIT=0；`9r-deploy.sh` syntax PASS
  - 部署后 DB：`quick_check=ok` / `journal_mode=delete` / `backupSchemaVersion=2`
  - deployment smoke PASS
- CodeBuddy `403 / code=11140 / modelLock 120s` 在同步完成后作为独立补丁修复；最终已验收代码基线为 `c2e20624`：safety 403 不再 token refresh、不写 `modelLock_*`、不进 combo cooling；普通权限类 403 仍保持 120s 锁定语义。

### 4.1.2 2026-09-23 同步记录（v0.5.85 → v0.5.86）

- 上游：`21583c03` (v0.5.85) → `39e36d3d` (v0.5.86)
- 规模：4 commits / 23 changed files
- 验证分支：`sync-upstream-0923-v0.5.86`（保留作审计历史，不删除，不作为发布分支）
- 正式发布分支仍为 `feat/combo-health-fallback`
- 真实双父 merge（非 squash、非 force push）：
  - merge commit：`d855b86c0a2556a08bee692235f1429d9856b595`（`merge: sync upstream v0.5.86 into combo branch`）
  - parent 1：`8e9b785287af56375d947e1ba6e7a7e10479dcff`（已验收 fork feature）
  - parent 2：`39e36d3d0c849e0e01dfeacddf111edf892448fc`（upstream v0.5.86）
- 本次上游主要内容：
  - Xiaomi MiMo：server-assisted desktop login、headless / Docker login、cn / sgp / ams / ru / in account clusters、`mimo-v2.6-pro` / `mimo-v2.6-flash` / `mimo-v2.6-pro-ultraspeed`、account-service / Cloud API dual route
  - Claude：`claude-opus-5-5`
  - Proxy Pools：修复 Headers 对象展开导致 Authorization / Content-Type 等 header 丢失
  - i18n：React characterData mutation translation
  - MiMo login security：session 仅 httpOnly cookie、proxy branch 要求 dashboard auth、不转发 Authorization / Proxy-Authorization
- 与 fork 自定义内容唯一 overlap：`src/dashboardGuard.js`
  - 保留 fork：`/api/usage/request-details/` 继续位于 `ALWAYS_PROTECTED`
  - 合入 upstream：`export { isAuthenticated };`，供 `src/proxy.js` 的 Xiaomi MiMo login proxy 复用 dashboard authentication
  - 两者语义兼容，无功能取舍
- 未受影响的 fork 核心（v0.5.86 未覆盖/破坏）：
  - Combo strategy resolver（`src/shared/utils/comboStrategy.js` 保留，`src/sse/handlers/chat.js` 继续使用 `resolveComboStrategy()`）
  - Combo health fallback
  - CodeBuddy 11140 request-scoped safety（safety 403 不写 modelLock、不进 combo cooling、不 token refresh；普通 403 仍 fallback / 120s lock）
  - SQLite DELETE/FULL/mmap_size=0、`backupSchemaVersion=2`
  - requestDetails reliability、usage custom fields、`9r-deploy.sh`
  - Fallback live smoke 已在上一轮验证：每个新请求从 model-1 开始、model-1 失败才切 model-2、下一次请求重新从 model-1 开始、health cooling 与 strategy rotation 已区分
- 验证结果（Tested SHA：`d855b86c0a2556a08bee692235f1429d9856b595`）：
  - v0.5.86 MiMo targeted：2 files passed / 16 passed / 0 failed
  - fork core regression：8 files passed / 58 passed / 0 failed
  - DB reliability：5/5 PASS（每轮 14 passed）
  - 附加 DB 测试 4 个失败均为 v0.5.85 已知 baseline（db-concurrent：100 parallel count loss、daily summary；request-details-tab：oversized truncated、getDistinctProviders anthropic），不是 v0.5.86 新 regression
  - `npm run build` EXIT=0；`bash -n 9r-deploy.sh` EXIT=0
  - full unit：sync 29 failed files / 222 passed / 3 skipped（80 failed tests / 2234 passed / 24 skipped）；master v0.5.86 baseline 29 failed files / 217 passed / 3 skipped（81 failed / 2181 passed / 24 skipped）
  - NEW REGRESSIONS = 0；FIXED = 1（db-concurrent mixed concurrent）
  - 结论：v0.5.86 sync validation = PASS（full-unit 有历史 baseline failure，非 100% 无失败）
  - 本轮没有实际部署

### 4.2 高频冲突文件预判

以下文件是本 fork 改动最集中的地方，上游若动同区域必然冲突：

| 文件 | 本 fork 的改动 |
|---|---|
| `src/lib/db/schema.js` | PRAGMA_SQL 改 DELETE 模式；两表加 comboName/requestedModel 列 |
| `open-sse/services/combo.js` | comboHealthState 失败记忆 Map + 冷却逻辑 |
| `open-sse/handlers/chatCore/*.js` | 8 个调用点透传 comboName/requestedModel |
| `src/lib/db/repos/requestDetailsRepo.js` | record 构建 + INSERT 9 列 |
| `src/app/(dashboard)/dashboard/usage/**` | 仪表盘明细列/筛选/Health 卡/冷却横条 |

**冲突解决原则：**

1. **schema.js 的 PRAGMA** —— **必须保我们的**（`journal_mode=DELETE` + `synchronous=FULL` + `mmap_size=0`）。上游是 WAL，合错会导致 DB 再次损坏（见 §6.4）
2. **新增列** —— 两边都保留，注意 `syncSchemaFromTables` 的 ALTER 逻辑别被覆盖
3. **combo.js 降级逻辑** —— 保我们的 `comboHealthState`，但上游若重构了 `handleComboChat` 结构，需把三处接线（入口过滤/成功清除/失败记录）重新接到新结构上
4. **handler 透传** —— 上游若新增调用点，需同步补 `comboName`/`requestedModel` 参数

### 4.3 冲突解决后的检查清单

```bash
# 1. 确认 PRAGMA 没被上游覆盖（最关键！）
grep -A3 'PRAGMA_SQL' src/lib/db/schema.js | grep -i 'journal_mode'
# 期望：journal_mode = DELETE

# 2. 确认降级逻辑还在
grep -n 'comboHealthState' open-sse/services/combo.js | head -3

# 3. 跑单测
npx vitest run tests/unit/combo-health-fallback.test.js

# 4. 构建 + 部署 + 验证
./9r-deploy.sh
```

---

## 5. 构建与运行

### 5.1 一键发版（推荐）

**只从 `feat/combo-health-fallback` 构建/部署当前自定义版本。**

```bash
cd ~/tujia_workspace/9router
git fetch origin
git checkout feat/combo-health-fallback
git pull --ff-only origin feat/combo-health-fallback
git status
git rev-parse HEAD
git rev-parse origin/feat/combo-health-fallback

./9r-deploy.sh                  # npm install → npm run build → launchctl 重启 → 5 项验证
./9r-deploy.sh --skip-build     # 跳过构建，只重启+验证（改 plist/数据时用）
./9r-deploy.sh -h               # 帮助
```

**脚本做的 5 项验证**：launchd PID / 宿主机 `/v1/models` / new-api 跨容器访问 / `journal_mode=delete` / 日志无 `malformed`。全绿才 exit 0。

### 5.2 运行方式

本地通过 **macOS launchd** 服务管理：

```bash
# 服务配置文件
~/Library/LaunchAgents/com.9router.local.plist
```

**plist 关键配置：**

```xml
<key>ProgramArguments</key>
<array>
    <string>/Users/qitmac001720/.local/bin/node</string>
    <string>/Users/qitmac001720/tujia_workspace/9router/custom-server.js</string>
    <string>--port</string>
    <string>20128</string>
</array>
<key>WorkingDirectory</key>
<string>/Users/qitmac001720/tujia_workspace/9router</string>
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<true/>
<key>ThrottleInterval</key>
<integer>10</integer>
```

- **RunAtLoad** = true → 登录后自动启动
- **KeepAlive** = true → 进程退出后自动重启（`ThrottleInterval=10` 秒防抖）
- **WorkingDirectory** → **必须指向源码仓库根**（launchd 默认 cwd=`/`，`next start` 找不到 `.next` 会起不来）
- **数据目录** → `~/.9router`（plist 中**不设** `DATA_DIR`，走源码默认值）
- **日志** → `~/.9router/logs/9router-local.{out,err}.log`

### 5.3 服务管理命令

```bash
# 查看状态（第一列=PID，第二列=退出码，0 为正常）
launchctl list | grep com.9router.local

# 重启（服务中断几秒）
launchctl kickstart -k "gui/$(id -u)/com.9router.local"

# 停止
launchctl unload ~/Library/LaunchAgents/com.9router.local.plist

# 启动 / 修改 plist 后重新加载
launchctl load ~/Library/LaunchAgents/com.9router.local.plist
```

> ⚠️ **plist 只在 load 时读取**：改完必须 `unload` + `load` 才生效，热改无效。

### 5.4 源码构建（手动，一般不需要）

```bash
cd ~/tujia_workspace/9router
npm install
npm run build
```

> 宿主机 32G 内存，`next build` 无压力（容器时代 2G 必 OOM，这是放弃容器的原因之一）。

---

## 6. 当前开发分支功能说明

**分支名：** `feat/combo-health-fallback`

**基于：** upstream/master `21583c03` / v0.5.85 (2026-09-22) + 自定义魔改

**领先 master：** 动态查询：`git rev-list --count master..feat/combo-health-fallback`

### 6.1 核心功能

#### 🔁 Combo 失败记忆（降级策略增强）

官方版的 combo 只有简单顺序回退，无失败记忆——404 的模型每个请求都要先撞一遍。

本 fork 新增 `comboHealthState` Map（key=`combo名::模型`）：

| 失败类型 | 冷却 |
|---|---|
| 404 / 401 / 403 | 2 分钟；连续 ≥3 次 → 15 分钟 |
| 429（带上游 retry） | 上游时间，封顶 30 分钟 |
| 502 / 503 / 504 | 不记 |
| 成功 | 清记录（自然半开恢复） |

入口自动跳过冷却中模型（日志 `skipping cooling models`）；**全员冷却时硬试**，不直接 503。

实现：`open-sse/services/combo.js`，单测 `tests/unit/combo-health-fallback.test.js`。

#### 📊 仪表盘增强

- 明细表新增 Status / Error / Account / **Combo** 列
- 日期快捷筛选（今天/24小时/7天/30天）、Status 下拉、Error 关键字搜索、Combo 下拉
- 概览 Health 卡（成功率 + 成功/失败/总数）
- Combos 页冷却横条（冷却中模型 + 失败次数 + 状态码 + 恢复倒计时）

#### 🏷️ 明细来源字段 comboName / requestedModel

之前明细只记最终落地的 provider/model，无法区分"哪个 combo 路由来的 / 客户端原始请求的 model"。

| 字段 | combo 请求 | 直连请求 |
|---|---|---|
| `comboName` | combo 名称 | null（前端显示 —） |
| `requestedModel` | 客户端原始 `body.model` | 客户端原始 `body.model` |

落盘到 `requestDetails` + `usageHistory` 两表（启动时 `syncSchemaFromTables` 自动补列）。

#### 💾 DB 写入重试

`requestDetailsRepo.flushToDatabase` 遇 `SQLITE_BUSY` / `database is locked` / `disk I/O error` 退避重试 4 次（50/100/200/400ms），其余错误不重试。此前批量写失败即整批丢弃（对应上游 issue #3488 的"usage 行静默丢失"）。

### 6.2 关键改动文件

| 文件 | 修改内容 |
|---|---|
| `src/lib/db/schema.js` | **PRAGMA 改 DELETE 模式**（治本）；两表加 comboName/requestedModel 列 |
| `open-sse/services/combo.js` | comboHealthState 失败记忆 + 冷却逻辑 |
| `open-sse/handlers/chatCore/*.js` | 8 个调用点透传 comboName/requestedModel |
| `src/lib/db/repos/requestDetailsRepo.js` | record 构建 + INSERT 9 列 + 写入重试 |
| `src/lib/db/repos/usageRepo.js` | INSERT 14 列 |
| `src/app/(dashboard)/dashboard/usage/**` | 明细列/筛选/Health 卡/冷却横条 |
| `9r-deploy.sh` | 一键发版脚本（自建，非上游） |

### 6.3 为什么不合回 master

自用分支，改动高度定制（绑定本机 launchd 部署形态、本地仪表盘偏好），合回上游无意义。

### 6.4 ⚠️ 最重要的一条：SQLite PRAGMA 不能回退到 WAL

**背景**：本机 9Router 曾因 **WAL 模式 + podman virtiofs bind mount 的 mmap 一致性 bug** 导致 SQLite **6 次损坏**。

**根因**：源码 `src/lib/db/schema.js` 的 PRAGMA_SQL 写死 `journal_mode = WAL`，每次启动都把库切回 WAL。**只改运行时 PRAGMA 无效**（重启即回退），必须改源码。

**当前值（必须保持）**：

```js
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA mmap_size = 0;
```

**合并上游时，如果这个 PRAGMA 被上游覆盖回 WAL，DB 会再次损坏。** 部署后务必验证：

```bash
sqlite3 -readonly ~/.9router/db/data.sqlite "PRAGMA journal_mode;"   # 必须回 delete
```

> 现已是宿主机直跑（非容器），virtiofs 这一层已消失，但 DELETE 模式仍保留（个人网关并发极低，无性能损失）。

### 6.5 配置示例（客户端接入）

| 客户端 | 配置 |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://localhost:20128` + API key |
| Codex CLI | `OPENAI_BASE_URL=http://localhost:20128/v1` |
| Cline/Continue/RooCode | Provider 选 OpenAI Compatible，Base URL `http://localhost:20128/v1`，model 填 combo 名 |

---

## 7. 常用命令速查

```bash
# ========== 同步上游 ==========
cd ~/tujia_workspace/9router
git fetch upstream
git checkout master && git merge upstream/master && git push origin master

# ========== 合并到开发分支 ==========
git checkout feat/combo-health-fallback
git merge upstream/master
# 解决冲突后（重点检查 schema.js 的 PRAGMA！）：
git add -A && git commit -m "merge: 合并 upstream/master"
git push origin feat/combo-health-fallback

# ========== 构建与发版 ==========
# 当前自定义版本只从 feat/combo-health-fallback 发布
git checkout feat/combo-health-fallback
git pull --ff-only origin feat/combo-health-fallback
git status
git rev-parse HEAD
./9r-deploy.sh                  # 完整（install + build + 重启 + 验证）
./9r-deploy.sh --skip-build     # 只重启+验证

# ========== 服务管理 ==========
launchctl kickstart -k "gui/$(id -u)/com.9router.local"    # 重启
launchctl list | grep com.9router.local             # 状态
launchctl unload ~/Library/LaunchAgents/com.9router.local.plist   # 停

# ========== 运行测试 ==========
npx vitest run tests/unit/combo-health-fallback.test.js

# ========== 健康检查 ==========
curl -s -m 5 http://localhost:20128/v1/models | head -c 120
sqlite3 -readonly ~/.9router/db/data.sqlite "PRAGMA journal_mode;"   # delete
sqlite3 -readonly ~/.9router/db/data.sqlite "PRAGMA quick_check;"    # ok
```

---

## 附：相关文档

| 文档 | 内容 |
|---|---|
| `HANDOFF.md` | 项目交接（当前状态、待办、变更记录） |
| `MAINTENANCE.md` | 维护手册（架构、排查、SQLite 恢复 SOP、发版流程） |
| `../ObsidianNotes/AgentSync/knowledge/9router-knowledge.md` | 知识库（部署形态、用量查询、故障案例） |
