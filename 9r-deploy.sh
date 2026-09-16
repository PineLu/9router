#!/usr/bin/env bash
# ============================================================
# 9Router 宿主机一键发版（构建 + launchd 重启 + 验证）
#
# 部署形态：宿主机源码直跑（launchd 托管），非容器。
#   - plist: ~/Library/LaunchAgents/com.9router.local.plist（RunAtLoad + KeepAlive）
#   - 数据:  ~/docker_workspace/9router/data（DATA_DIR，与容器时代同一份）
#   - 端口:  20128
# 详见 knowledge/9router-knowledge.md「部署形态」。
#
# 用法:
#   ./9r-deploy.sh               完整流程：install → build → 重启 → 验证
#   ./9r-deploy.sh --skip-build  跳过构建，只重启+验证（改 plist/数据时用）
#   ./9r-deploy.sh -h            帮助
#
# 退出码: 0 = 全部通过; 1 = 某步失败
# ============================================================
set -uo pipefail

NODE="$HOME/.local/bin/node"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # 仓库根（脚本就在仓库根目录）
DATA_DIR="$HOME/docker_workspace/9router/data"
PLIST_LABEL="com.9router.local"
LOG="/tmp/9r-deploy-$(date +%Y%m%d-%H%M%S).log"
DB="$DATA_DIR/db/data.sqlite"
KEY="sk-8f45b56418ed9762-eeacsv-96a55e63"   # Default Key，仅本机验证用
PODMAN=/opt/homebrew/bin/podman

SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) awk 'NR>2 && /^# ={20,}$/ {exit} NR>2 {print}' "$0"; exit 0 ;;
    *) echo "未知参数: $a（用 -h 看帮助）"; exit 1 ;;
  esac
done

step() { echo; echo "======== $1 ========"; }

if [ $SKIP_BUILD -eq 0 ]; then
  step "1/3 构建（npm install + next build，在 $SRC_DIR）"
  cd "$SRC_DIR" || exit 1
  npm install --silent 2>&1 | tail -1
  npm run build >"$LOG" 2>&1 || { echo "❌ 构建失败，日志尾部："; tail -20 "$LOG"; exit 1; }
  echo "构建完成（日志: $LOG）"
fi

step "2/3 launchd 重启（服务中断几秒）"
launchctl kickstart -k "gui/501/$PLIST_LABEL" || { echo "❌ kickstart 失败"; exit 1; }
sleep 6

step "3/3 验证"
FAIL=0

# 3.1 launchd 状态
P=$(launchctl list | grep "$PLIST_LABEL" | awk '{print $1}')
if [ -n "$P" ] && [ "$P" != "-" ]; then
  echo "launchd: $PLIST_LABEL 运行中 PID=$P"
else
  echo "❌ launchd 服务未运行"; FAIL=1
fi

# 3.2 网关 API（宿主机）
R=$(curl -s -m 8 -H "Authorization: Bearer $KEY" http://localhost:20128/v1/models | head -c 60)
echo "宿主机 /v1/models: ${R:0:60}"
echo "$R" | grep -q '^{"object":"list"' || { echo "❌ 宿主机 API 不通"; FAIL=1; }

# 3.3 new-api 容器 → 宿主机 9Router（podman 内置域名）
if [ -x "$PODMAN" ] && "$PODMAN" ps --format '{{.Names}}' 2>/dev/null | grep -q '^new-api$'; then
  R2=$("$PODMAN" exec new-api wget -q -O - -T 5 --header "Authorization: Bearer $KEY" \
        http://host.containers.internal:20128/v1/models 2>/dev/null | head -c 60)
  echo "new-api → host.containers.internal:20128: ${R2:0:60}"
  echo "$R2" | grep -q '^{"object":"list"' || { echo "❌ new-api → 9Router 不通"; FAIL=1; }
else
  echo "⚠️ new-api 容器没在跑（或 podman 不可用），跳过跨容器验证"
fi

# 3.4 数据库完好 + journal 模式正确（防 WAL 回潮）
if [ -f "$DB" ]; then
  JM=$(/usr/bin/sqlite3 -readonly "$DB" "PRAGMA journal_mode;" 2>&1)
  echo "journal_mode: $JM（应为 delete）"
  [[ "$JM" == "delete" ]] || { echo "❌ journal_mode 不是 delete，WAL 回潮了！"; FAIL=1; }
  QC=$(/usr/bin/sqlite3 -readonly "$DB" "PRAGMA quick_check;" 2>&1 | head -1)
  [[ "$QC" == "ok" ]] || { echo "❌ 数据库 quick_check 异常: $QC"; FAIL=1; }
else
  echo "⚠️ 找不到 $DB，跳过 DB 验证"
fi

# 3.5 运行日志无 malformed
OUT_LOG="$DATA_DIR/logs/9router-local.out.log"
MAL=$(tail -100 "$OUT_LOG" 2>/dev/null | grep -c malformed || true)
echo "近100行日志 malformed: $MAL 条"
[ "$MAL" -eq 0 ] || { echo "❌ 仍有 malformed"; FAIL=1; }

echo
if [ $FAIL -eq 0 ]; then
  echo "✅ 全部通过：9Router 新版本已上线（宿主机直跑），网关/跨容器/数据库均正常"
  exit 0
else
  echo "❌ 有 $FAIL 项验证失败，见上方输出"
  exit 1
fi
