#!/bin/bash
# 小说部署脚本 — 将已完成的小说上传到 GitHub Pages
# 用法: bash deploy.sh [小说名]
#       不传参数则部署所有小说

set -e

REPO_DIR="/Users/taopengyu/lobsterai/project/xiaobubuya-github-io-temp"
NOVELS_DIR="/Users/taopengyu/lobsterai/project/workspace/novels"
NOVELS_JSON="$REPO_DIR/novels/index.json"

cd "$REPO_DIR"

# 确保 novels 目录存在
mkdir -p "$REPO_DIR/novels"

# 收集所有小说元数据
echo "📚 扫描小说..."
NOVELS=()
if [ -n "$1" ]; then
  # 部署指定小说
  if [ -d "$NOVELS_DIR/$1" ]; then
    NOVELS=("$1")
  else
    echo "❌ 未找到小说: $1"
    exit 1
  fi
else
  # 部署所有小说
  for d in "$NOVELS_DIR"/*/; do
    NOVELS+=("$(basename "$d")")
  done
fi

METADATA='{"novels":[]}'

for name in "${NOVELS[@]}"; do
  echo "  → $name"
  NOVEL_DIR="$NOVELS_DIR/$name"
  
  # 读取设定获取小说信息
  SETTINGS="$NOVEL_DIR/settings.txt"
  OUTLINE="$NOVEL_DIR/outline.txt"
  
  # 解析标题
  TITLE=$(head -1 "$SETTINGS" 2>/dev/null | sed 's/# //' || echo "$name")
  
  # 解析类型和风格
  TYPE=$(grep -m1 "类型" "$SETTINGS" 2>/dev/null | sed 's/.*类型[：:]//' || echo "")
  STYLE=$(grep -m1 "风格" "$SETTINGS" 2>/dev/null | sed 's/.*风格[：:]//' || echo "")
  
  # 统计章节数和字数
  CHAPTER_COUNT=$(ls "$NOVEL_DIR/chapters/"*.txt 2>/dev/null | wc -l | tr -d ' ')
  WORD_COUNT=$(cat "$NOVEL_DIR/chapters/"*.txt 2>/dev/null | wc -m | tr -d ' ')
  
  # 简介
  DESC=$(grep -A2 "核心冲突" "$SETTINGS" 2>/dev/null | tail -1 || echo "")
  
  # 构建章节索引
  CHAPTERS='[]'
  if [ "$CHAPTER_COUNT" -gt 0 ]; then
    CHAPTERS='['
    FIRST=true
    for ch in "$NOVEL_DIR/chapters/"*.txt; do
      [ -f "$ch" ] || continue
      CH_NAME=$(basename "$ch" .txt)
      CH_TITLE=$(head -1 "$ch" | sed 's/# //' || echo "$CH_NAME")
      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        CHAPTERS+=','
      fi
      CHAPTERS+="{\"file\":\"$CH_NAME.txt\",\"title\":\"$CH_TITLE\"}"
    done
    CHAPTERS+=']'
  fi
  
  # 创建 novels 目录中对应文件夹
  mkdir -p "$REPO_DIR/novels/$name"
  
  # 写入章节索引
  echo "{\"chapters\":$CHAPTERS}" > "$REPO_DIR/novels/$name/index.json"
  
  # 复制章节文件
  for ch in "$NOVEL_DIR/chapters/"*.txt; do
    [ -f "$ch" ] || continue
    cp "$ch" "$REPO_DIR/novels/$name/"
  done
  
  # 追加元数据
  METADATA=$(echo "$METADATA" | python3 -c "
import json, sys
data = json.load(sys.stdin)
data['novels'].append({
  'name': '$name',
  'title': '$TITLE',
  'type': '$TYPE',
  'style': '$STYLE',
  'chapters': $CHAPTER_COUNT,
  'words': '$WORD_COUNT',
  'desc': '$DESC'
})
json.dump(data, sys.stdout)
" 2>/dev/null || echo "{\"novels\":[{\"name\":\"$name\",\"title\":\"$TITLE\",\"type\":\"$TYPE\",\"style\":\"$STYLE\",\"chapters\":$CHAPTER_COUNT,\"words\":\"$WORD_COUNT\",\"desc\":\"$DESC\"}]}")
done

# 写入整合元数据
echo "$METADATA" > "$NOVELS_JSON"
echo "📝 novels/index.json 已更新"

# Git 提交推送
echo "🚀 提交到 GitHub..."
git add -A
git commit -m "deploy novels: $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || echo "  无变更"
git push origin main 2>/dev/null || git push origin master 2>/dev/null || echo "  push 完成"

echo "✅ 部署完成！"
echo "   https://xiaobubuya.github.io"
