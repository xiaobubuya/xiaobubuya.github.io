# Tasks

## 1. Spec 修正

- [ ] 1.1 按代码现状改写 `album` 的四条 requirement（比例档位、撤销 30 步、层级按钮、图注无编辑入口、删去微调/换图、冲突两个选项），验证 `openspec validate` 通过
- [ ] 1.2 归档合入主 spec，验证 `openspec show album --type spec` 反映新文本

## 2. 复核

- [ ] 2.1 对照 `album.js` / `album.html` 逐条复核数值（ratio 映射、undo 上限 30、debounce 900、吸附阈值、旋转 5°），确保每条都有代码依据
