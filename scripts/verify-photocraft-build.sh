#!/usr/bin/env bash
#
# 校验 photocraft/ 里就是我们的自建构建（带 AI Bridge 的那份），
# 并与 photocraft-build.lock 里钉死的指纹逐项比对。
#
#   用法（在仓库根目录）：
#     scripts/verify-photocraft-build.sh            # 校验，失败退出 1
#     scripts/verify-photocraft-build.sh --update   # 重新生成指纹（仅在成功构建后）
#
# 纯 bash + sha256sum，不依赖 jq。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

LOCK=photocraft-build.lock
MODE="${1:-verify}"

fail() { echo "::error::$*"; printf 'FAILED: %s\n' "$*" >&2; exit 1; }
ok()   { printf '  ok  %s\n' "$*"; }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

lockval() {
  # 取 key=value 里的 value；注释行忽略
  sed -n "s/^${1}=//p" "$LOCK" | head -1
}

[ -f "$LOCK" ] || fail "缺少 $LOCK"

# ── 找出当前产物 ────────────────────────────────────────────────────────────
# build-photocraft-wasm.yml 用内容哈希命名，文件名会随构建变化，
# 所以 --update 时从目录里自动发现，而不是写死文件名。
find_one() {
  local pattern="$1"
  local hits
  hits=$(find photocraft -maxdepth 1 -name "$pattern" -type f 2>/dev/null | sort)
  local n
  n=$(printf '%s\n' "$hits" | grep -c . || true)
  [ "$n" -eq 1 ] || fail "photocraft/ 里匹配 $pattern 的文件应有 1 个，实际 $n 个：
$hits"
  printf '%s\n' "$hits"
}

CUR_WASM_PATH=$(find_one 'photocraft-web-*_bg.wasm')
CUR_JS_PATH=$(find_one 'photocraft-web-[0-9a-f]*.js')
CUR_WASM=$(basename "$CUR_WASM_PATH")
CUR_JS=$(basename "$CUR_JS_PATH")

if [ "$MODE" = "--update" ]; then
  echo "=== 重新生成 $LOCK（当前产物）==="

  # 生成指纹之前先确认产物本身真的带 Bridge —— 否则等于把坏的锁进锁文件。
  for sym in $(lockval bridge_symbols); do
    grep -q "$sym" "$CUR_JS_PATH" \
      || fail "构建产物 $CUR_JS 里没有 $sym —— 这不是打过 AI Bridge 的构建，拒绝写锁"
  done
  echo "  bridge symbols 齐全：$(lockval bridge_symbols)"

  [ -f ai-widget.js ] || fail "根目录缺 ai-widget.js"
  [ -f photocraft/ai-widget.js ] || fail "photocraft/ 缺 ai-widget.js"

  {
    sed -n '/^#/p' "$LOCK"
    echo "wasm_file=$CUR_WASM"
    echo "wasm_sha256=$(sha "$CUR_WASM_PATH")"
    echo "js_file=$CUR_JS"
    echo "js_sha256=$(sha "$CUR_JS_PATH")"
    echo "widget_sha256=$(sha ai-widget.js)"
    echo "bridge_symbols=$(lockval bridge_symbols)"
    echo "min_wasm_bytes=$(lockval min_wasm_bytes)"
  } > "$LOCK.new" && mv "$LOCK.new" "$LOCK"

  echo "  已写入 $LOCK"
  grep -E '^(wasm|js|widget)' "$LOCK" | sed 's/^/    /'
  exit 0
fi

# ── verify ──────────────────────────────────────────────────────────────────
EXP_WASM=$(lockval wasm_file)
EXP_WASM_SHA=$(lockval wasm_sha256)
EXP_JS=$(lockval js_file)
EXP_JS_SHA=$(lockval js_sha256)
EXP_WIDGET_SHA=$(lockval widget_sha256)
MIN_BYTES=$(lockval min_wasm_bytes)

[ -n "$EXP_WASM" ] || fail "$LOCK 里缺 wasm_file"
[ -n "$EXP_WASM_SHA" ] || fail "$LOCK 里缺 wasm_sha256"
[ -n "$EXP_JS" ] || fail "$LOCK 里缺 js_file"
[ -n "$EXP_JS_SHA" ] || fail "$LOCK 里缺 js_sha256"

echo "=== 1. 产物文件名必须与指纹一致 ==="
[ "$CUR_WASM" = "$EXP_WASM" ] || fail "wasm 文件名与锁不符：
  锁内   = $EXP_WASM
  实际   = $CUR_WASM
  说明：photocraft/ 被换成了别的构建。若是自建的合法升级，跑
       scripts/verify-photocraft-build.sh --update 更新锁并一起提交。"
[ "$CUR_JS" = "$EXP_JS" ] || fail "js 文件名与锁不符：
  锁内   = $EXP_JS
  实际   = $CUR_JS"
ok "wasm = $CUR_WASM"
ok "js   = $CUR_JS"

echo "=== 2. 内容校验和必须一致 ==="
GOT_WASM_SHA=$(sha "$CUR_WASM_PATH")
[ "$GOT_WASM_SHA" = "$EXP_WASM_SHA" ] || fail "wasm 校验和不符（文件被改过）：
  锁内 = $EXP_WASM_SHA
  实际 = $GOT_WASM_SHA"
GOT_JS_SHA=$(sha "$CUR_JS_PATH")
[ "$GOT_JS_SHA" = "$EXP_JS_SHA" ] || fail "js 校验和不符：锁内 $EXP_JS_SHA / 实际 $GOT_JS_SHA"
ok "wasm sha256 = $GOT_WASM_SHA"
ok "js   sha256 = $GOT_JS_SHA"

echo "=== 3. wasm 体积下限（拦上游 98KB 桩）==="
WASM_BYTES=$(wc -c < "$CUR_WASM_PATH" | tr -d ' ')
[ "$WASM_BYTES" -ge "$MIN_BYTES" ] || fail "wasm 只有 $WASM_BYTES 字节，低于下限 $MIN_BYTES —— 这是上游 release 的桩，不是自建构建。"
ok "wasm 体积 = $WASM_BYTES 字节（下限 $MIN_BYTES）"

echo "=== 4. AI Bridge 符号必须真的编进产物 ==="
for sym in $(lockval bridge_symbols); do
  grep -q "$sym" "$CUR_JS_PATH" || fail "构建产物里没有 $sym —— AI Bridge 不在，悬浮球会是死按钮"
  ok "bridge symbol: $sym"
done

echo "=== 5. index.html 的 shim 与 script 标签 ==="
[ -f photocraft/index.html ] || fail "缺 photocraft/index.html"
grep -q 'window\.photocraft' photocraft/index.html \
  || fail "photocraft/index.html 缺 AI Bridge shim（window.photocraft）"
grep -q 'src="ai-widget.js"' photocraft/index.html \
  || fail "photocraft/index.html 缺 <script src=\"ai-widget.js\">"
ok "photocraft/index.html: shim + script 标签都在"

[ -f lightcraft/index.html ] || fail "缺 lightcraft/index.html"
grep -q 'src="\.\./ai-widget.js"' lightcraft/index.html \
  || fail "lightcraft/index.html 缺 <script src=\"../ai-widget.js\">"
ok "lightcraft/index.html: script 标签在"

echo "=== 6. ai-widget.js 两份必须一致 ==="
[ -f ai-widget.js ] || fail "根目录缺 ai-widget.js"
[ -f photocraft/ai-widget.js ] || fail "photocraft/ 缺 ai-widget.js"
GOT_WIDGET_SHA=$(sha ai-widget.js)
[ "$GOT_WIDGET_SHA" = "$EXP_WIDGET_SHA" ] || fail "根目录 ai-widget.js 校验和不符：
  锁内 = $EXP_WIDGET_SHA
  实际 = $GOT_WIDGET_SHA"
PC_WIDGET_SHA=$(sha photocraft/ai-widget.js)
[ "$PC_WIDGET_SHA" = "$GOT_WIDGET_SHA" ] || fail "photocraft/ai-widget.js 与根目录那份不一致"
ok "ai-widget.js sha256 = $GOT_WIDGET_SHA（两份相同）"

echo "=== 7. 不得出现上游 boot 产物 ==="
# 上游 v0.16.0 的文件名形如 photocraft-web-boot-<hash>.js。
# 它出现在 photocraft/ 里就是被上游包覆盖过的证据。
STRAY=$(find photocraft -maxdepth 1 -name 'photocraft-web-boot-*' -type f 2>/dev/null)
[ -z "$STRAY" ] || fail "photocraft/ 里出现了上游产物：
$STRAY
  这说明 photocraft/ 被上游 release 包覆盖过 —— 那里面没有 AI Bridge。"
ok "无上游 boot 产物"

echo ""
echo "PASSED: photocraft/ 是我们的自建构建（含 AI Bridge）"
