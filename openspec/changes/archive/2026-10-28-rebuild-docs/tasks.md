# Tasks

## 1. 归档旧文档

- [ ] 1.1 在 `openspec/changes/archive/` 下建立 `legacy-docs/` 目录，把 `docs/` 下八份原文（CONTEXT/PRD/PRD-NAV/HANDOFF/AI_WIDGET/ROADMAP/REFERENCES/AI_WIDGET-FIX-RECORD）移入，并在 `legacy-docs/README.md` 写映射表：每份文档 → 它已被提炼进哪一个 capability spec；验证移动后路径存在、原文内容未被删改
- [ ] 1.2 在 `docs/` 保留一份简短 `README.md`，说明「文档真相来源已迁到 `openspec/`，旧文档归档于 `openspec/changes/archive/legacy-docs/`」；验证该说明可读且指向正确路径

## 2. 主 spec 落位

- [ ] 2.1 把 9 个 delta spec 通过 `openspec archive`（或 sync）合并到 `openspec/specs/<capability>/spec.md` 作为新建主 spec；验证 `openspec list --specs` 出现全部 9 个 capability 且每个有 `## Purpose` 与合法 requirement/scenario 结构
- [ ] 2.2 运行 `openspec validate --all` 确认全部 spec 合法（无零 delta、无缺 scenario、description 不超长），有告警则逐条核对是否需修

## 3. AGENTS.md 入口

- [ ] 3.1 新建根 `AGENTS.md`：说明本仓库是 muyaya.world 前端、文档真相在 `openspec/`、如何用 openspec 流程（propose/apply/sync/archive）、关键铁律（公开仓库零密钥、改壳升 `sw.js` 版本、`photocraft/` 只由 CI 构建、AI 后端只允许命名隧道）；验证 AGENTS.md 存在且可被新 Agent 读
- [ ] 3.2 在 `openspec/config.yaml` 的 `context` 字段补充本仓库真实形态（GitHub Pages 静态前端 + VPS Node 后端边界 + 上述铁律），验证 config 可被 openspec 读取且 context ≤ 51,200 字节

## 4. 集成校验

- [ ] 4.1 跑一遍 `node test/run-all.mjs --fast`（或至少 `test/sw-version.test.mjs`、`test/line-endings.test.mjs`）确认文档重构未破坏静态测试；验证输出通过
- [ ] 4.2 提交并推送到 main（若允许），或生成一份验收清单供用户审查；验证 git 变更清单里不含任何 `.html` / `.js` / `.css` 运行时代码改动
