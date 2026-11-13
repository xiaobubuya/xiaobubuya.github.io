#!/usr/bin/env bash
# 把本仓库里仍然服务线上的静态应用同步到 nginx 目录。
#
# 2026-11-13 起站点不再走 GitHub Pages：muyaya.world 由本机 nginx 直接从
# /var/www 发文件，所以这里没有「push 就生效」的魔法，必须显式跑一次。
#
# 只同步三类东西：
#   photocraft/   自建构建（含 AI Bridge 与 widgets），→ /var/www/photocraft
#   lightcraft/   上游原包，→ /var/www/lightcraft
#   ai-widget.js  AI 悬浮球本体，两个应用各一份
#
# 不同步的东西：
#   /var/www/muyaya        由 muyaya-web 仓库的 deploy.sh 负责，别在这里碰
#   /var/www/pose          独立构建
#   本仓库的 index.html / app.js / album.html 等旧 Pages 前端（线上已不用）
#
# 用法：
#   bash scripts/deploy-static-apps.sh            # 正常同步
#   bash scripts/deploy-static-apps.sh --dry-run  # 只看会改哪些文件
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PC_DEST=/var/www/photocraft
LC_DEST=/var/www/lightcraft
DRY=()
[ "${1:-}" = "--dry-run" ] && DRY=(--dry-run)

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# 先确认指纹锁是通的：widget 和 wasm 对不上时不要往外发
say "== 校验 photocraft/ 构建指纹 =="
bash "$REPO_ROOT/scripts/verify-photocraft-build.sh" >/dev/null \
  || { echo "✗ photocraft-build.lock 校验失败，先修产物再部署" >&2; exit 1; }
echo "  ok"

say "== 同步 PhotoCraft → $PC_DEST =="
rsync -a --delete "${DRY[@]}" \
  --exclude '.DS_Store' \
  "$REPO_ROOT/photocraft/" "$PC_DEST/"

say "== 同步 LightCraft → $LC_DEST =="
# --delete 会抹掉 dest 里有、src 里没有的东西。lightcraft/ 是上游原包，
# 但 dest 里多出来的 ai-widget.js / .gz / .br 是我们自己加的，必须排除。
rsync -a --delete "${DRY[@]}" \
  --exclude '.DS_Store' \
  --exclude 'ai-widget.js' \
  --exclude '*.gz' \
  --exclude '*.br' \
  "$REPO_ROOT/lightcraft/" "$LC_DEST/"

say "== 同步 ai-widget.js（两份副本）=="
if [ ${#DRY[@]} -eq 0 ]; then
  install -m 644 "$REPO_ROOT/ai-widget.js" "$PC_DEST/ai-widget.js"
  install -m 644 "$REPO_ROOT/ai-widget.js" "$LC_DEST/ai-widget.js"
  # ai-widget.js 走 no-cache（nginx 里有专门 location），不需要 .gz 预压缩
  chmod -R a+rX "$PC_DEST" "$LC_DEST"
else
  echo "  (dry-run 跳过 install)"
fi

say "== 指纹核对（三份 ai-widget.js 必须一致）=="
sha256sum "$REPO_ROOT/ai-widget.js" "$PC_DEST/ai-widget.js" "$LC_DEST/ai-widget.js" \
  | awk '{print "  " $1 "  " $2}'
ROOT_SHA=$(sha256sum "$REPO_ROOT/ai-widget.js" | cut -d' ' -f1)
for f in "$PC_DEST/ai-widget.js" "$LC_DEST/ai-widget.js"; do
  [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$ROOT_SHA" ] \
    || { echo "✗ $f 与源文件不一致" >&2; exit 1; }
done
echo "  ok"

say "部署完成。验证："
echo "  curl -sI https://muyaya.world/photocraft/ai-widget.js | grep -i cache-control"
echo "  curl -s  https://muyaya.world/lightcraft/ai-widget.js | grep -c image/jpeg"
