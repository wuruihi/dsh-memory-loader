# dsh-memory-loader

[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

**DeepSeek Harness（DSH）确定性记忆注入插件**：每个新会话开始时，把两级记忆自动注入上下文——不依赖模型「自觉去 read」，对齐并超越 Claude Code auto-memory 的效果，且预算与层级可控。

English summary: a DSH plugin that deterministically injects your two-level memory (global `~/.dsh/memory/` + project `<cwd>/memory/`, each `MEMORY.md` plus today's `YYYY-MM-DD.md`) into every new agent session via the `agent/pre-step` seam, with an independent byte budget.

## 为什么需要它

DSH 原生只自动加载指令文件链（`AGENTS.md` / `CLAUDE.md`），不加载 `memory/` 目录；指令文件里写的「会话开始先读记忆」依赖模型自觉，是概率性的。本插件把这一步变成 harness 级确定性注入。

## 注入内容与顺序（broad → specific）

1. `~/.dsh/memory/MEMORY.md`（全局长期）
2. `~/.dsh/memory/YYYY-MM-DD.md`（全局当日，若存在）
3. `<cwd>/memory/MEMORY.md`（项目长期，若存在）
4. `<cwd>/memory/YYYY-MM-DD.md`（项目当日，若存在）

cwd 取 `agent.session.header.cwd`，不硬编码任何项目路径。

### 内容策略：什么值得占用「每个会话」的槽位

注入是**每次会话都要付**的成本，而会话开始时任务还没出现——所以判据不是"有没有用"，而是**"模型不知道它，会不会做错事"**：

| 内容 | 处理 | 为什么 |
|---|---|---|
| `MEMORY.md` ×2 | **整份注入** | 它本身是指针（索引）。不知道索引 = 不知道 `memory/` 下有哪些文件，记忆库对模型等于不存在 |
| 当日日志 `YYYY-MM-DD.md` | 默认**只注入一行指针**（条数/体积），正文按需 `read` | 日志是**写侧流水**，真正的读者是策展流程（沉淀／做梦），不是随手打开的工作会话；它增长最快、密度最低，却最容易挤掉索引 |
| `rules_*.md` / `context/` | **不注入**，走 `AGENTS.md` 钩子 + skill 前置必读按需读 | 只在相关任务里才有用，放进每个会话就是噪声——但"知道去哪找"必须确定 |

`dailyLogMode` 取值：`pointer`（默认，只注入指针）｜`full`（v1.2 行为，注入被字节上限截断的正文）｜`off`（完全不提日志）。指针模式保留了"确定性知道日志存在"这一半价值，把正文成本推迟到真正需要时。

## 安装

### 方式 A：plugin add（bundle 形态，推荐）

```sh
dsh plugin --profile web add https://github.com/wuruihi/dsh-memory-loader/archive/refs/heads/main.tar.gz
```

### 方式 B：单文件 file:// 挂载

把 `dsh-memory-loader.mjs` 放到 `~/.dsh/profiles/web/` 下（该目录能解析 `@deepseek-ai/dsh-llm` 裸包名），然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-memory-loader
      name: file:///<绝对路径>/~/.dsh/profiles/web/dsh-memory-loader.mjs
      config:
        maxBytes: 16384
        maxSourceBytes: 65536
        dailyLogMode: pointer
```

patch 变更由 `watchUserPatches` 热应用，无需重启。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxBytes` | 16384 | 注入帧总预算（字节），独立于 AGENTS.md 链的 64KB |
| `maxSourceBytes` | 65536 | 单文件读取上限，超限视为不存在（并报 `skipped`） |
| `dailyLogMode` | `pointer` | 当日日志处理：`pointer` 只注入一行指针／`full` 注入被截断正文／`off` 不提 |
| `dailyLogMaxBytes` | 4096 | 仅 `dailyLogMode: full` 生效：日志正文的注入上限 |

预算策略与官方 `dsh-agent-instructions` 一致：超限时先整文件丢弃最不特定者，最后截断最特定文件并附提示。

> **这些数字的来历（别当物理常数）**：`16KB` 是从官方 instructions 插件沿用的约定，不是按上下文压力测出来的——它真正的作用是**逼出信息密度 + 保护索引**（若理由是上下文稀缺，那 AGENTS.md 链拿 64KB 就说不通）。`4096 = 16384 ÷ 4` 是四个候选文件等分的启发式。两个已知取舍：①截断是**保头部、砍尾部**，对追加型日志方向相反（最新结论在尾部 → 这正是默认改指针的原因之一）；②"越泛的先丢"承自 instructions 场景，对记忆并不完全成立（全局 `MEMORY.md` 是最耐久的索引，却排在最先被丢的位置）。

## 设计要点

- **标记缺失则注入**：一个规则覆盖新会话 / resume / 子代理 / fork 继承四种场景；帧内含固定标记，扫描会话历史去重，不会重复注入
- **注入 seam 与官方 instructions 插件同源**：`agent/pre-step` 包装下游 decision，`createUserMessage`（from `@deepseek-ai/dsh-llm`）构造 durable user 消息，紧跟用户首条 prompt
- **安全**：内容中字面 `</system-reminder>` 被转义，防止记忆内容逃逸帧；任何内部错误只降级为放弃注入，不影响会话
- **只读不写**：沉淀仍按你自己的记忆协议走，插件不碰写回

## 验证

```sh
node selfcheck.mjs
```

53 项自检覆盖：四文件加载顺序、预算整丢/截断策略、当日日志三种模式（pointer 默认／full／off，含"关掉指针则正文回灌"的反证）、帧转义、日期文件名、有界读取、幂等标记。本机另有端到端验证记录（headless 会话哨兵注入 + 会话存储解压取证 + 回滚对照），见交付报告。

## License

MIT
