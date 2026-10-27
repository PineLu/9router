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
| `master` | 跟踪上游，保持干净（2026-10-09 同步目标 `ce4460ef` / v0.5.99，与 upstream/master 一致） |
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

### 4.1.3 2026-10-02 同步记录（v0.5.91 → v0.5.95）

- 上游：`f01fb909` (v0.5.91) → `a99cf572` (v0.5.95)，41 commits / 137 changed files。
- 验证分支：`sync-upstream-1002-v0.5.95`。
- tested code merge：`efe37df7136c7328a722c26735922c182e5f861f`，双父分别为 `0a5025a6` + `a99cf572`。
- 实际冲突 4 个：`open-sse/handlers/chatCore.js`、`open-sse/services/accountFallback.js`、`src/sse/handlers/chat.js`、`src/sse/services/auth.js`。
- 冲突融合原则：保留 fork 的 Combo resolver / CodeBuddy 11140 / retry-window，同时吸收 upstream 的 `requestedModel`、`providerOverrides`、provider-scoped fallback。
- 独立 Codex review 额外修复 2 个 upstream 风险：
  1. bare GPT 路由改为按 Codex registry 精确 model id 判断，避免 OpenAI-only `gpt-5.4*` 误走 Codex；
  2. TLS 证书失败默认不再 insecure retry，只有显式 `STRICT_SSL=false/0` 才允许。
- 验证：核心/新增高风险定向回归通过；最终路由/TLS/strict-proxy 4 files / 34 tests PASS；`npm run build` PASS；`bash -n 9r-deploy.sh` PASS。
- 已知 upstream baseline：`codex-gpt6-lite` 的 contextWindow 旧断言（272000 vs 1050000）；Provider baseline 的 Codex CLI header 版本滞后；另有 Provider Header UI 对 TinyFish search/fetch 不生效的 upstream P2。
- `feat/combo-health-fallback` 已于 2026-10-02 fast-forward 到 `efe37df7`；同日完成宿主机最终部署，`9r-deploy.sh` exit 0，launchd / 宿主机 `/v1/models` / new-api 跨容器访问 / SQLite `journal_mode=delete` / 运行日志检查全部通过。

### 4.1.4 2026-10-09 同步记录（v0.5.95 → v0.5.99）

- 上游：`a99cf572` → `ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8`（v0.5.99，2026-10-08），29 commits / 163 changed files；本次按确切 SHA 同步，未依赖尚未更新的 Git tag。
- 隔离验证：`sync-upstream-1009-v0.5.99`，使用独立 Git worktree，未修改生产 `.next` 或重启 launchd。
- **tested code merge**：`60a647f27e7f632dd6bdaa2eaf4a2080a3abacb0`，双父 `aa8ff01b` + `ce4460ef`；7 个双方修改文件，只有 `src/sse/handlers/chat.js` 出现 2 处实际文本冲突。
- 冲突融合：保留 fork 的 `resolveComboStrategy()` / Combo Health 和所有 provenance 字段，接入上游 `enforceKeyAccess()` / `filterAdapterModels()`，确保 API Key 白名单在模型/Combo 请求入口生效，并限制扩展的 capacity adapter 模型。
- **数据库门禁**：本 fork 和上游都已使用 `SCHEMA_VERSION=2`，但修改内容不同；合并后改为 `3`，保证已记录 v2 的数据库在增列 `apiKeys.accessRestricted/accessAllow` 前执行 schema 备份。保留 `DELETE/FULL/mmap_size=0`，新增 v2→v3 实际迁移/备份单测。
- 上游重点：Bedrock (含 AWS SSO)、Antigravity Gemini 3.8 与 Claude 5.5、Hermes 多 profile、API Key 访问隔离、MiniMax Code、Netlify Relay、Kimi Responses 等。
- 定向门禁：API Key/Combo/数据库迁移相关 4 files / **61 tests PASS**；原扩大高风险组合 58 files / 483 pass、4 fail，经对照其中 2 项为长期 Combo baseline，其余为 GLM 1M 与 Schema v3 的旧断言，均已修正。
- **full-unit 差集**：sync 67 failed files / 85 failed tests / 2980 passed / 24 pending；官方 v0.5.99 同机 baseline 69 failed files / 87 failed tests / 2921 passed / 24 pending。按失败用例标识对比 **NEW REGRESSIONS=0；FIXED=2**（GLM Combo context 断言、DB mixed concurrent）。
- `npm run build` PASS；独立进程 `127.0.0.1:23129` + 临时 DATA_DIR smoke PASS（`/v1/models` 814 项、SQLite `quick_check=ok`、`journal_mode=delete`、日志 `malformed=0`），进程和临时数据已清理。
- 独立 Codex **只读静态 review**：未发现本次融合新增的 P0/P1/P2；其 Vitest 尝试因只读沙箱禁止写入临时目录未执行，真实单测由 Runner 独立执行并完成差集比较。
- 已知 upstream baseline：Alias、Provider 快照仍滞后，官方同 SHA 验证同样失败（含 Codex CLI header、Kimi Responses、MiniMax Code）；OAuth URL PASS。不得把这些历史失败描述成全量绿灯。
- **同步 ≠ 部署**：正式分支推进后，运行服务仍使用 2026-10-02 部署的 v0.5.95 产物；仅在另行从 `feat/combo-health-fallback` 执行 `9r-deploy.sh` 并验证 5 项 live smoke 后才能标记 v0.5.99 已上线。

### 4.1.5 2026-10-09 v0.5.99 正式部署与数据安全验证

- **部署代码 SHA**：`feat/combo-health-fallback @ cc55371e`（在 `60a647f2` 合并基础上增加 `362119bb` 安全修复及 `cc55371e` UI 门禁测试）；使用**生产 Node 22.22.3** 执行 `9r-deploy.sh`，完整 npm install/build/launchd restart/smoke **exit 0**。
- **独立 Codex 复审**：发现上游 Netlify Relay 公开任意目标代理风险；本 fork 禁止新建 Netlify 部署（API 固定 HTTP 403，界面入口不可交互），保留其他 Relay 和已有代理池兼容；复审所提 P2 UI 测试覆盖已补，定向测试通过。
- **生产切换前异常**：旧服务实际 DB 是 `journal_mode=wal`，且存在正被旧进程使用的 `data.sqlite-wal`，不可只拷贝主 SQLite 文件。旧库 `quick_check=ok`，`backupSchemaVersion=2`。
- **独立安全备份**：采用 SQLite 在线 `.backup` 把主库与已提交 WAL 事务一致地复制到私有目录 `~/.9router-upgrade-backups/pre-v0599-20261009-110349/`；额外保存最新 `latest-pre-switch.sqlite`、认证/本地标识文件及旧构建 `previous-next/`（旧 `.next` 约 1.1GB）。备份库 `integrity_check=ok` 且可独立以 `DELETE` 模式打开；该私有目录不可自动清理，须保留作为回滚依据。备份含敏感认证材料，禁止上传或提交仓库。
- **真实旧库副本迁移演练**：隔离 worktree 中分别用 Node 25/`node:sqlite` 和生产同版 Node 22.22.3/`better-sqlite3` 启动 v0.5.99；均正常完成 `backupSchemaVersion 2→3` 备份、自动增列、`DELETE` 和 `integrity_check=ok`。原始配置和业务表计数未变化，历史用量 13552、请求明细 1000 条均保留。
- **生产 live smoke**：launchd 新 PID `11840` 正常，宿主机 `/v1/models` HTTP 200，new-api 容器可通过 `host.containers.internal:20128` 请求，`journal_mode=delete`，`quick_check=ok`，近 100 行日志 `malformed=0`；部署后额外 `integrity_check=ok`，`backupSchemaVersion=3`，API Key 的 2 个新权限列存在，`-wal/-shm` 文件均不存在。
- **生产全量记录数对比**：切换前最新快照、切换后均为 `apiKeys=3` / `combos=3` / `providerConnections=14` / `usageHistory=13552` / `requestDetails=1000`。新旧 `.next/BUILD_ID` 不同，确认正式服务运行新构建。未认证的 Netlify 部署入口 HTTP 401（网关登录保护），认证后后端仍固定 403。
- **结论**：v0.5.99 **已上线并完成真实库迁移验收**；本次未观察到数据损坏或记录丢失。数据库备份和旧版构建快照保留，不承诺任何软件升级绝对零风险。

### 4.1.6 2026-10-16 v0.5.104 同步准备与融合验证

- **上游版本**：`upstream/master @ 87a74e1b` / v0.5.104（2026-10-15），相对当前 v0.5.99 定制分支新增 **38 commits**；在独立分支 `sync-upstream-1016-v0.5.104` 执行 `--no-ff` 合并准备。
- **冲突**：仅 `open-sse/services/combo.js` 1 处文本冲突。融合时同时保留 fork 的 `comboHealthState`/cooling/请求级安全拒绝处理和上游新增的“HTTP 200 但 zero usable content 时继续 fallback”。由于 fork 会先过滤 cooling seat，最后节点判断必须使用 `attemptModels.length`，不能照搬 upstream 的 `rotatedModels.length`；已补回归测试锁定该场景。
- **Codex 路由**：v0.5.104 上游移除 `gpt-5.5`/`gpt-5.5-review`/对应 image 等退役模型。fork 继续采用“真实 Codex registry 精确白名单”路由裸 model id，而不是上游宽泛 `gpt-5.x/6.x` 正则；测试改为直接调用真实路由，确认退役 `gpt-5.5` 与非 Codex `gpt-5.4` 回 OpenAI，`gpt-5.6-*`、`gpt-6-astra`、daybreak/reserve、`codex-auto-review` 仍走 Codex OAuth。
- **安全/数据不变量**：`src/lib/db/schema.js` 仍为 `journal_mode=DELETE` + `synchronous=FULL` + `mmap_size=0`；默认 TLS 证书校验仍严格，仅显式 `STRICT_SSL=false/0` 才允许 insecure retry；Netlify Relay 新建入口仍被 fork 禁用。
- **定向门禁**：Combo health/fallback/strategy/content-filter/caps、Codex registry/auto-review、TLS、strictProxy/Cursor、Netlify Relay 共 **11 files / 96 tests PASS**。
- **full-unit 基线对照**：融合分支同机运行结果为 **36 failed files / 88 failed tests / 3630 passed**；纯 `upstream/master @ 87a74e1b` 同环境为 **37 failed files / 90 failed tests / 3570 passed**。两者均存在上游测试基线问题（含 translator/Windsurf/Kiro timeout 等），因此不得写成“全量绿灯”；本次高风险定向门禁无新增失败。
- **build**：`npm run build` PASS；随后使用临时 `DATA_DIR` 隔离真实运行库再次构建，**exit 0 且无 DB lock 警告**。第一次未隔离构建虽 exit 0，但读取了 `~/.9router/db/data.sqlite` 并出现 lock/备份警告，故不作为干净验收证据。
- **状态**：截至本节记录时仅完成同步分支融合与验证，**尚未合回 `feat/combo-health-fallback`，尚未部署 v0.5.104**。正式部署仍需从最终定制分支执行 `9r-deploy.sh` 并完成 live smoke/DB 校验。

### 4.1.7 2026-10-16 v0.5.104 正式部署与生产验收

- **部署代码**：`feat/combo-health-fallback @ cf284ff1b720c11ebb8b5ee25899d1cb8e33b8b8`；该提交已 fast-forward 到正式定制分支并 push 到 origin，完整包含 `upstream/master @ 87a74e1b` / v0.5.104。
- **升级前门禁**：生产 launchd 正常；SQLite `journal_mode=delete`、`quick_check=ok`、`integrity_check=ok`。使用 SQLite 在线 `.backup` 生成一致性备份，并保留认证/本机标识和上一版 `.next` 构建快照；备份库再次验证 `delete/ok/ok`。
- **部署**：执行 `./9r-deploy.sh`，完整 build → launchd restart → 5 项 smoke **exit 0**。新 launchd PID=`77979`；宿主机 `/v1/models` 正常；new-api 可通过 `host.containers.internal:20128` 跨容器访问；`journal_mode=delete`；近 100 行日志 `malformed=0`。
- **深校验**：`/api/version` 返回 `currentVersion=0.5.104`、`latestVersion=0.5.104`、`hasUpdate=false`；生产库 `quick_check=ok`、`integrity_check=ok`，且不存在 `data.sqlite-wal/-shm`。
- **数据对账**：升级前一致性备份与升级后生产库关键表计数完全一致：`apiKeys=3`、`combos=3`、`providerConnections=14`、`usageHistory=18391`、`requestDetails=1000`；`backupSchemaVersion=3`，`appVersion=0.5.104`。
- **结论**：v0.5.104 **已正式上线并通过生产验收**；未观察到关键表记录丢失、SQLite 完整性异常或 WAL 回退。升级前私有备份保留作为回滚依据。

### 4.1.8 2026-10-27 v0.5.111 隔离同步与融合验证

- **来源**：上游 `upstream/master @ 3a978a63` / v0.5.111（2026-10-26），相对上次已部署 v0.5.104 新增 56 commits、298 files；包含 v0.5.109 的 Combo Smart Router、SSE 空响应降级、Web Providers，以及 v0.5.111 的 Codex Image、OpenCode/TLS、Ollama、Kimi K3.1 Pro 等更新。
- **隔离**：在独立 Git worktree `sync-upstream-1027-v0.5.111` 内从 fork 正式基线 `94f67e98` 合并 `upstream/master`，依赖/Next 构建和测试均不复用或覆盖正式源码目录的 `.next`。整个准备阶段不重启线上服务。
- **冲突**：实际 7 个文件发生文本冲突：`chatCore.js`、`accountFallback.js`、`combo.js`、`proxyFetch.js`、`stream.js`、Combo dashboard、`combo-caps-resolver` 测试。融合时保留 fork 的 `comboName` 透传、失败记忆与 cooling、CodeBuddy 11140 免锁账号、TLS 默认证书验证；同时吸收上游 Smart Router、request-scoped 4xx、SSE peek 及自定义 RTK 提示词。JSON 和 SSE 的最后一个可用节点均使用 `attemptModels.length`，新增 SSE cooling 回归。
- **契约冲突修复**：上游 `checkFallbackError` 第 4 参数是 provider，fork 历史第 4 参数是 retryAfter；统一为 `(status, errorText, backoffLevel, provider, retryAfter)` 并调整 account/Combo 两处调用，保留上游 CodeBuddy Intl 11128 backoff 与 fork retry window。修正上游新测试对 `comboCtx` 第三参数、request-scoped 400、`requestScoped` 结果字段的过时断言。
- **定向门禁**：首轮 15 files / 190 tests PASS；后续 CodeBuddy/Combo/SSE/TLS 6 files / 117 tests PASS。覆盖 Smart Router、Combo health/cooling、请求级拒绝、流式空响应、TLS 默认严格与 Netlify 安全禁用等。
- **全量同环境基线**：融合分支第二轮 416 files、**4174 passed / 24 failed**；纯 upstream v0.5.111 为 410 files、**4120 passed / 30 failed**，按失败用例标识对比 **新增失败 0**。遗留失败含 golden headers 快照、测试环境依赖/外部 live 测试，不应描述成全量绿灯。测试自动写入的 snapshot 修改已撤销，不纳入 fork 提交。
- **build**：在 worktree 使用临时 `DATA_DIR` 完整 `npm run build` 两轮均 exit 0；静态页与 standalone 资产完成。生产数据不参与构建。
- **SQLite 与安全不变量**：`journal_mode=DELETE`、`synchronous=FULL`、`mmap_size=0` 未被覆盖；Netlify Relay 后端依旧固定 403；TLS insecure retry 仅显式 `STRICT_SSL=false/0` 且没有 `strictTls=true` 才触发。
- **状态**：本节记录为源码同步/集成验收，**不是生产部署记录**。线上 v0.5.104 仍需维持至另行备份并执行完整部署验证后，才能宣称 v0.5.111 已上线。

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

**基于：** upstream/master `87a74e1b` / v0.5.104 (2026-10-15) + fork 定制；当前正式分支/上线代码 `cf284ff1`；**2026-10-16 已正式部署 v0.5.104**（详见 §4.1.7）

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
