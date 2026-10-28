# ai-agent-server 部署链路与服务器安全修复记录（2026-10-28）

> 承接 `AI-BRIDGE-FIX-2026-10-27.md`。那份记录解决的是「解析为什么失败」，
> 本文解决的是「修复为什么上不了线」和「服务器在被打」。
>
> 仓库公开，本文不含任何密钥/token 明文。

## 现象

1. **部署 CI 卡死**：`deploy-ai-agent.yml` 的 deploy job 单次跑 **4 小时**不结束，
   日志停在 `sshpass` 上传环节。
2. **部署后线上反而 401**：`POST /api/parse` 返回 `{"error":"指令解析失败","detail":"401 Forbidden"}`，
   前端悬浮球表现为「无法解析指令」。
3. **dsh 不可用**：部署后 `/usr/local/bin/dsh --version` 报
   `Cannot find package 'js-yaml'`。

## 根因（四个独立缺陷叠加）

### 1. 每次部署上传 161MB 的 harness 包

CI 的 build job 执行 `npm install @deepseek-ai/dsh` 并把整个 `node_modules`
（161MB，含 sharp-libvips / node-pty / ripgrep 等）打进部署 tar 包上传。

国内服务器接收该包时 TCP 半开，tar 传到中途即断（实测解包报
`gzip: stdin: invalid compressed data` / `Unexpected EOF`），
`scp` 会话挂死 31 分钟不退出 —— 这就是「跑 4 小时」的真相。

**业务代码（dist）只有 332KB。** 服务器 `/opt/ai-agent-server/harness` 早已有
完整的 dsh 0.2.1-rc.2，根本不需要每次重传。

### 2. heredoc 用单引号，`.env` 的密钥被置空

部署脚本写成：

```bash
sshpass -e ssh ... "${SERVER_USER}@${SERVER_HOST}" << 'REMOTE_SCRIPT'
```

单引号禁止本地展开，而 secret 只是通过 GitHub Actions 的 `env:` 传给本地
`sshpass` 进程，远程 shell 并没有这些变量。于是远程的 `$LLM_API_KEY` 展开为**空**，
`$API_KEY` 为空则落到代码里的默认值。

结果：`.env` 里 `LLM_API_KEY=` 为空 → 所有 LLM 调用 401。

### 3. dsh 被指向缺依赖的 harness 副本

部署脚本无条件执行：

```bash
ln -sf /opt/ai-agent-server/harness/.bin/dsh /usr/local/bin/dsh
```

而该副本缺 `js-yaml`（全局 `@deepseek-ai/dsh` 的依赖里才有）。
原本指向全局完好版本的 `dsh` 被覆盖成坏的，直接不可用。

### 4. `API_KEY` 被覆盖，与前端硬编码不一致

`ai-widget.js` 里 `const API_KEY = 'bubu'`（前端公开仓库，无法放密钥）。
部署却把 `.env` 的 `API_KEY` 写成默认值，两边不一致 → 前端所有请求 401。

## 修复

### 部署包瘦身（关键）

`deploy-ai-agent.yml` 删除 build 里的 `Install DeepSeek Harness` 与打包 harness 步骤。
部署 tar 现在只含 `dist / package.json / ecosystem.config.cjs / .env.example`，
**上传量 161MB → <1MB**。

另加 SSH 保活，防半开挂死：

```bash
SSH_OPTS="-o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30"
```

### 变量正确传入远程

secret 改为作为 ssh 命令的环境变量前缀（heredoc 仍用单引号，避免本地误展开脚本内变量）：

```bash
sshpass -e ssh $SSH_OPTS "${SERVER_USER}@${SERVER_HOST}" \
  "LLM_API_URL='$LLM_API_URL' LLM_MODEL='$LLM_MODEL' API_KEY='$API_KEY' LLM_API_KEY='$LLM_API_KEY' bash -s" << 'REMOTE_SCRIPT'
```

### dsh 优先用全局完好版本

```bash
GLOBAL_DSH=""
for c in /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
         /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js; do
  if [ -f "$c" ] && node "$c" --version >/dev/null 2>&1; then GLOBAL_DSH="$c"; break; fi
done
```

只在全局版本不可用时才回退 harness 副本。

### 保留服务器现有 `API_KEY` / `LLM_API_KEY`

secret 缺失时回退服务器已有值，避免再次把 `.env` 置空：

```bash
EXISTING_API_KEY="$(grep '^API_KEY=' .env 2>/dev/null | cut -d= -f2- || echo '')"
API_KEY="${EXISTING_API_KEY:-${API_KEY}}"
```

`PHOTOCRAFT_SERVE_TOKEN` 同理，从服务器 `photocraft-serve.token` 文件复用
（tar 解包不覆盖该文件）——否则部署会让图片执行链路（serve gateway）鉴权失败。

## 验证

部署完成后在服务器实测：

| 检查项 | 结果 |
|---|---|
| `.env` 的 `LLM_API_URL` / `LLM_MODEL` | sensenova 网关（secret 值） |
| `.env` 的 `LLM_API_KEY` | 非空（35 位） |
| `.env` 的 `API_KEY` | `bubu`（与前端一致，未被覆盖） |
| `.env` 的 `PHOTOCRAFT_SERVE_TOKEN` | 保留原值 |
| `/usr/local/bin/dsh` | 指向全局版本，`--version` = `0.2.1-rc.2` |
| `POST /api/parse`（key=bubu，一句话两改） | 返回 2 条命令，日志 `[Parse] (photocraft, harness)` 且无回退 |
| `POST /api/chat` | `[Harness] agent 完成` → 任务完成并输出成片 |
| `/api/health` | `{"status":"ok"}` |

## 部署后自测（每次部署必走）

自 2026-10-28 起，**每次 `deploy-ai-agent.yml` 部署成功后必须走一遍固定清单**，
不再靠临时判断。完整清单（含可复制脚本与故障对照表）在后端仓库：

> `deepseek-harness/apps/ai-agent-server/DEPLOY-SMOKE.md`

包含四段：

1. **环境自检** — `/api/health`、`.env` 关键项（`API_KEY=bubu`、`LLM_API_KEY` 与
   `PHOTOCRAFT_SERVE_TOKEN` 非空）、`dsh` 指向全局完好版本、skill 预加载、进程状态。
2. **功能验证（3 条）** — 旋转180度（变换类）、黑白+对比（多命令 + 默认参数）、
   高斯模糊（滤镜类）。三条分别覆盖 skill 查询、sanitize 边界、新命令透传。
3. **端到端** — `POST /api/chat` 真执行并产出 `*_result*.png`，日志不得出现
   `harness 失败，回退单次 LLM`。
4. **故障对照表** — 症状 → 根因 → 修复（401、dsh 缺 js-yaml、部署卡数小时、
   serve token 丢失、命令被误丢等）。

判断标准只有一条：**清单全绿才算部署成功**；任一项不合预期，按对照表排查后再决定回滚。

## 命令清单：从 17 个扩展到引擎全量 920 个

### 现象

用户说「把照片旋转 180 度」，harness 回答：

> ❌ 需求包含旋转180度操作，但旋转操作无法用现有命令表达（可用命令仅限图像调整类）

### 根因

不是引擎不支持。`photocraft-cli commands --json` 显示引擎有 **920 个命令**，
其中旋转/翻转明确存在：

```
edit.transform.rotate180 / rotate90Cw / rotate90Ccw
edit.transform.flipHorizontal / flipVertical
image.imageRotation.flipCanvasHorizontal / flipCanvasVertical
```

问题在 `PHOTOCRAFT_COMMANDS` 只手工挑了 17 个 `image.adjustments.*`，
prompt 里又硬编码「你只能使用下面这些命令 id」——模型严格照办，自然说做不到。

### 方案：skill + 按需查询（而非全量塞 prompt）

920 条命令原始 JSON 是 310KB，精简渲染仍约 25K tokens，每次解析都塞进 prompt 不现实。

改为：

1. 新增 dsh skill `photocraft-commands`，内容是「用
   `photocraft-cli commands --json --filter <关键词>` 查真实命令与参数规格」，
   agent 需要时自行加载并按关键词过滤查询。
2. harness 以 **`DSH_PERMISSION_MODE=danger-full-access`** 启动。
   依据：`dsh-base` 的 bundle 里写死了开关——
   `policy: (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`。
   headless 没有审批通道，不改这个开关，agent 执行任何 bash 都会被拒。
3. `PHOTOCRAFT_AGENT_PROMPT` 不再带硬编码清单，只给查询方法与输出格式；
   `PHOTOCRAFT_SYSTEM_PROMPT`（17 条内置清单）保留给**无工具的 LLM fallback**。
4. `sanitizeCommands` 的 id 校验从「只认内置 17 个」放宽到「引擎全量集合」
   （`getEngineCommandIds()` 调 `commands --json`，缓存 5 分钟）；
   新增类命令参数原样透传，由引擎自身校验。
5. 部署时把 skill 打包并预加载到 `/root/.dsh/skills/`，避免重新部署丢失。

### 顺带修掉的 bug

`sanitizeCommands` 原有「参数全丢光就没意义 → 丢弃整条命令」的逻辑。
但 `blackWhite` 的参数都有默认值（`reds=40/yellows=60/...`），agent 省略参数是合法的，
结果「改成黑白 + 提高对比度」只剩对比度一条（日志：`丢弃了 1 条无效命令:
image.adjustments.blackWhite(参数无效)`）。已去掉该判断——真缺必填项时由引擎执行阶段报错。

### 验证

| 需求 | 结果 |
|---|---|
| 旋转180度 | `edit.transform.rotate180` + `{target:"pixels"}` |
| 改成黑白并提高对比度 | `blackWhite` + `brightnessContrast`（2 条） |
| 高斯模糊半径5 | `filter.blur.gaussianBlur` |
| chat 端到端旋转 | 任务完成并产出 PNG |

### 风险

`danger-full-access` 意味着 agent 理论上可执行任意命令。prompt 里约束了
「除 `photocraft-cli commands` 查询外不要执行其他命令」，但这是软约束。
当前为内网服务、任务范围固定，风险可接受；若要更严，可给 dsh 配 bash 工具 guard
只放行 `photocraft-cli`。

## fail2ban 上线（服务器安全）

`/var/log/auth.log`（Debian 系统认证日志）显示当日 **14966 次** SSH 失败登录，
来源集中在 `109.160.32.x` 网段多 IP 轮换——典型爆破集群。

核实**没有任何来自该网段的成功登录**，所有 `Accepted` 均来自本人出口 IP 与
GitHub Actions runner，未被攻破。

加固：

| 项目 | 配置 |
|---|---|
| 版本 | Fail2Ban 0.10.2（Debian 10 归档源） |
| 服务 | enabled + active，开机自启 |
| jail | `sshd`（封 1 小时）+ `recidive`（1 天内被 ban 3 次 → 封 1 周） |
| 参数 | `maxretry=5 / findtime=600s / bantime=3600s` |
| 配置 | `/etc/fail2ban/jail.local`（持久，不被包更新覆盖） |
| 忽略 | 本机、`::1`、`192.168.0.0/16` |
| 监控 | `/var/log/auth.log` |

效果：上线后 4 分钟内失败登录仅 1 次（此前约 10–15 次/分钟），
已封禁 2 个源 IP（iptables `f2b-sshd` 链 REJECT）。

**不影响部署**：GitHub Actions 用正确密码成功登录，不产生失败计数，不会被封。

## 遗留问题

1. **根因仍是 `PermitRootLogin yes` + `PasswordAuthentication yes`**。
   fail2ban 是事后拦截，根治要改纯密钥登录；该变更可能锁死自己，
   需先验证 `authorized_keys`、`reload` 而非 `restart`、并保留现有会话。
2. **harness 升级方式变了**：部署不再携带 dsh。以后升级要手动
   `npm install -g @deepseek-ai/dsh`（或另加专门的 harness job），
   否则服务器会一直用旧版本。
3. **`API_KEY` 现在以服务器现有值为准**，secret 里的 `API_KEY` 不再生效。
   若要统一，需同步修改 `ai-widget.js` 里的硬编码。
4. **harness 以 `danger-full-access` 运行**：agent 能执行 bash 才能查引擎命令，
   但这也意味着理论上可执行任意命令。当前靠 prompt 约束 + 内网环境控制风险；
   若要硬隔离，需给 dsh 配 bash 工具 guard 只放行 `photocraft-cli`。
5. **skill 内容与引擎版本耦合**：`photocraft-commands` skill 只是「怎么查」的说明，
   命令清单本身实时来自引擎，因此引擎升级后无需改 skill；但若引擎改了
   `commands` 子命令的用法/输出格式，需同步更新 skill。
6. **命令参数区间以引擎为准**：内置 `PHOTOCRAFT_COMMANDS`（给 LLM fallback 用）里
   `brightnessContrast.contrast` 写的是 `-100..100`，引擎实际为 `-50..100`。
   仅影响无工具的 fallback 路径，harness 路径走实时引擎规格，不受影响。
7. **`LLM_API_URL` 末尾多一个斜杠**（secret 值自带 `.../v1/`）。实测 OpenRouter 兼容
   拼接正常，未改；介意可去 secret 里修正。

## 回滚

- 部署链路：`git revert` 对应 commit 后重新 push 即可（`deploy-ai-agent.yml`）。
- fail2ban：`systemctl disable --now fail2ban`，`iptables -F f2b-sshd`。

## 顺带改动

- `.env` 备份留存：`/opt/ai-agent-server/.env.bak-deploy-broken`（部署故障时的现场）。
- `deepseek-harness` 仓库 remote 由 HTTPS 改为 SSH：
  服务器到 `github.com:443` 超时、但 `:22` 通，改 SSH 后 `fetch` 由 >60s 卡死降至 6s。
