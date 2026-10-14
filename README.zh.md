# cc-rsi

[English](README.md) | 中文

**面向 Claude Code 的递归自我改进插件。** cc-rsi 把 [RSIAgent](https://github.com/AetherLabsAI/RSIAgent)（arXiv:2609.15364）中与具体评测基准无关的机制移植成一个 Claude Code 插件，移植路径经过更早的 [dsh-rsi](https://github.com/mutsuki14/dsh-rsi)：

- **为日常工作配备独立验证者。** Claude 完成一项不简单的任务后会调用 `submit`。另一个无头 `claude -p` 进程对照你本人最近的几条消息检查实时工作区，它看不到 Claude 的推理过程，最后给出 `PASS`、`FAIL` 或 `UNVERIFIED` 以及一份报告。检查前工作区会先打检查点，检查后再恢复。
- **执行者自有、经过验证的经验记忆。** 拿到终局判定后，Claude 可以把可复用的操作流程、脚本、环境事实和失败教训蒸馏进按项目存放的记忆。记忆只能通过原子化、有日志的两步提交来修改。之后的每个会话都能看到它的只读视图。
- **后台运行的探索谱系。** 一个脱离会话的引擎在后台运行 RSIAgent 的 Phase 1（课程智能体按波次编写的广度练习）、Phase 2（目标与练习交替的深度探索）和 Phase 3（冻结复用），执行者、验证者和课程智能体都是无头子进程。每一步都写入日志，所以崩溃、手动停止或基础设施故障只会让谱系暂停，`resume` 就能接着跑。
- **封存评测。** 可选的评测命令只能在终端里给谱系的最终候选结果打分，分数永远不会进入任何模型上下文。

模型参数始终不变，能力的提升全部来自经过验证的经验，并通过记忆在任务之间传递。

设计与信任边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，规范性说明见 [docs/design/SPEC.md](docs/design/SPEC.md)（英文；它早于最近一轮修复，两者不一致时，以代码和架构文档中的[与规范的有意偏离](docs/ARCHITECTURE.md#recorded-deviations-from-the-specification)为准）。

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [日常使用](#日常使用)
- [探索谱系](#探索谱系)
- [Phase 3：冻结、冻结谱系与封存评测](#phase-3冻结冻结谱系与封存评测)
- [配置](#配置)
- [隔离：哪些受保护，哪些不受保护](#隔离哪些受保护哪些不受保护)
- [命令行参考](#命令行参考)
- [~/.cc-rsi 目录与 gc](#cc-rsi-目录与-gc)
- [故障排查](#故障排查)
- [版本与更新](#版本与更新)
- [开发](#开发)
- [已知限制](#已知限制)
- [与 RSIAgent 仍然存在的差异](#与-rsiagent-仍然存在的差异)
- [致谢与引用](#致谢与引用)

## 环境要求

| 要求 | 说明 |
|---|---|
| Claude Code ≥ 2.1.295 | 角色子进程依赖钩子的 `onFailure`，这需要 2.1.295。开发和测试使用 2.1.296。`cc-rsi doctor` 会检查版本和所有必需的命令行参数。 |
| Claude Code 所见的 `PATH` 上有 Node.js ≥ 18 | 钩子、MCP 服务器和命令行工具都用 `node` 运行；没有它，钩子会失败，MCP 服务器也起不来。没有任何 npm 依赖。 |
| git | 用于采集变更事实、打检查点和判断判定是否过期。没有 git 时这些功能会降级（`doctor` 会给出警告）。 |
| POSIX | macOS、Linux 或 WSL2。不支持原生 Windows。 |
| 操作系统沙箱（可选） | Linux 需要 `PATH` 上有 `bubblewrap` 和 `socat`；macOS 使用自带的 `/usr/bin/sandbox-exec`；WSL1 无法使用沙箱。没有沙箱时请阅读[隔离](#隔离哪些受保护哪些不受保护)一节。 |

## 安装

在 Claude Code 里：

```
/plugin marketplace add mutsuki14/CC-RSI
/plugin install cc-rsi@cc-rsi
```

也可以一步完成：

```
/plugin install cc-rsi --marketplace mutsuki14/CC-RSI
```

在 shell 里：

```sh
claude plugin marketplace add mutsuki14/CC-RSI && claude plugin install cc-rsi@cc-rsi
# 安装时可以顺便设置插件选项，例如
claude plugin install cc-rsi@cc-rsi --config verifier_model=opus --config sandbox=require
```

本地开发，或者不安装直接试用一份检出：

```sh
claude --plugin-dir /path/to/CC-RSI
```

安装后新开一个会话，再运行 `/cc-rsi:doctor` 检查环境。

**终端命令。** 仅限人工操作的命令（封存评测、解冻、恢复、放弃谱系、释放锁、取消验证等）只能在终端里运行。每次会话启动时，插件都会刷新 `~/.cc-rsi/bin/cc-rsi` 这个转发脚本（设置了 `CC_RSI_HOME` 时为 `$CC_RSI_HOME/bin/cc-rsi`），让它运行最近一次会话所用的插件。在 shell 配置文件里把它所在的目录加入 `PATH` 一次即可：

```sh
export PATH="$HOME/.cc-rsi/bin:$PATH"
```

不用这个脚本的话，也可以运行 `node "<插件目录>/bin/cc-rsi" …`。通过插件市场安装的插件位于 `~/.claude/plugins/cache/<marketplace>/cc-rsi/<version>/`；用 `--plugin-dir` 时就是你的检出目录。仅限人工的命令在 Claude Code 内被拒绝时，会打印应在终端里运行的完整命令行（`in a terminal, run: …`）：转发脚本存在时用它的绝对路径，否则用 `node <插件目录>/bin/cc-rsi`。`cc-rsi doctor`（检查项 `shim`）会在转发脚本不存在、指向已不存在的插件目录或所在目录不在 `PATH` 上时给出警告，并打印需要添加的 `export PATH=…` 行。

## 日常使用

不需要手动启动任何东西。照常和 Claude 协作即可，插件的钩子会把 RSI 协议加入会话。

### 你会看到什么

会话启动时会出现一行状态，例如：

```
cc-rsi: Verifier isolation = rollback (sandbox unavailable: bubblewrap (bwrap) not installed, socat not installed); Verifier model = inherit (session model not yet known); memory 12 files (learn)
```

在 Claude Code 2.1.296 上，SessionStart 的输入不带模型信息，所以 cc-rsi 会在第一次调用 cc-rsi 工具或第一次结束时从会话的对话记录里读出会话模型，并一直沿用到下一次会话启动或 `/model`（由别的模型完成的轮次，比如计划模式或降级轮次，不会改变它）。只有当前这个 Claude Code 进程写下的记录才算数：`--resume`、`--continue` 或分叉之后，之前那个进程写下的记录（可能是在另一个 `--model` 下写的）会被跳过，所以第一轮里模型还未知，由下一次结束时记下。在此之前，继承会话模型的验证者显示为 `inherit (session model not yet known)`，并使用链条上的下一个模型（`ANTHROPIC_MODEL`、`~/.claude/settings.json` 里的 `model`、Claude Code 的默认模型）。只有当验证者模型和会话模型都已知且相同时，这一行末尾才会追加 `; WARNING: Verifier model equals the session model`。如果记忆在提交之外被改动过，也会追加一条警告。

Claude 完成一项不简单的任务后会调用 cc-rsi 的 `submit` 工具，你会看到它收到的判定：

```
cc-rsi · Verifier: VERDICT: FAIL (generation 1, isolation=rollback, model=claude-…)
<验证者报告原文>
<给 Claude 的后续指引>
```

完整流程：

```
你的请求 → Claude 工作（可以读取记忆视图）
  → submit             给工作区打检查点；一个脱离会话的作业启动无头验证者，
                       它只看到你最近 3 条消息（仅文本）和实时工作区；
                       在此期间 Claude 对该工作区的编辑和 shell 命令都会被暂停
  → PASS | FAIL | UNVERIFIED，附报告；工作区随后被恢复
       FAIL        Claude 修复后再次 submit；恢复的是同一个验证者会话，
                   并告诉它自上次检查以来改了什么
       UNVERIFIED  Claude 可以带着 evidence_leads（CLAIM/PROBE 对）重新提交；验证者把它们
                   当作线索自行核实，harness 从不执行这些命令
  → learn              拿到 PASS 或 FAIL 后：打开一份记忆草稿用于蒸馏
  → memory_commit      （带上阶段消息里的 6 位十六进制确认码）进入调和阶段
  → memory_commit      （新的确认码）原子提交：写入日志，并记录提交前后的树哈希
```

- **你的消息**指的是你亲手输入的提示（UserPromptSubmit 的 `source` 为 `user`，`-p` 运行时为 `sdk`）。任务通知、队友和频道消息、斜杠命令、其他由机器注入的轮次，以及 Claude 为自己安排的提示（CronCreate、ScheduleWakeup、RemoteTrigger、`/loop`）都不会被采集，因此永远不会成为验证者的任务。负载里有 `source` 时以它为准；没有时，只有 Claude Code 完整的包装格式才会被认作队友或频道消息，所以你以 `<channel>` 开头的提示仍然算你的。安排的提示只有在安排调用成功后才会被记下；一次性的提示只认一次，你删除的、已经触发或过期的安排，不会再让你亲手输入的同样文本被漏掉。只有某个任务列表曾经列出过、之后又不再列出的安排才算已经消失：会话任务以 Claude Code 传给结束钩子的任务列表为准，持久的 CronCreate 任务以 `<project>/.claude/scheduled_tasks.json` 为准；还没有任何列表列出过的安排，在被删除之前、最多 8 天内都会被认出。
- **同一个验证者会话**只有在以下条件都满足时才会被恢复：它的对话记录与上一个作业结束时完全一致（cc-rsi 在每个作业结束后记录一份指纹）、验证者模型没有变化、闲置时间不超过 `interactive.verifierIdleHours`。否则会开启新的验证者上下文，并附上之前的报告，以及自最近一次发布了报告的检查以来改了什么（被恢复的验证者听到的是自它自己上次检查的那棵树以来改了什么）。
- **`submit` 之前启动的进程**（后台 Bash 任务、开发服务器）会继续运行；暂停只针对 Claude 新发起的编辑和命令。在沙箱模式的检查期间，验证者自己无法改动候选结果，所以一旦候选结果发生变化，作业就以基础设施结果 `candidate_changed_during_inspection` 结束，不产生判定。在回滚模式下，如果检查期间已有文件被改动（仅新建的文件不算，`node_modules`、`.venv` 和 `__pycache__` 下未跟踪的文件也不算），得到的 `PASS` 仍会记录，但永远不算当前有效，结果里会附一条 NOTE 说明。`submit` 之前请先停掉这类进程。

每次 `submit` 或 `wait_verdict` 最多等待约 100 秒（`interactive.waitSeconds`），并且会及早结束等待，以便在 Claude Code 把调用转入后台之前约 10 秒返回（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`，默认 120 秒，从调用到达时算起）。验证时间更长时，结果会显示 `VERIFICATION RUNNING (job …)`，Claude 随后调用 `wait_verdict`；判定落地时，一个异步钩子也会尝试唤醒会话（每个作业一次）。验证进行期间，读取文件不受影响。

### MCP 工具（服务器 `rsi`）

| 工具 | 用途 | 谁可以调用 |
|---|---|---|
| `submit` | 对当前工作区发起（或加入）一次独立验证。可选参数 `evidence_leads: [{claim, probe}]`，只在 `UNVERIFIED` 之后使用（最多 16 条）。 | 仅主对话 |
| `wait_verdict` | 等待并接收正在进行或尚未送达的判定。 | 仅主对话 |
| `learn` | 拿到 `PASS` 或 `FAIL` 后，在项目记忆的草稿上打开学习阶段。学习阶段已打开时，`learn` 会重新给出当前阶段的消息和确认码。 | 主对话，`mode: learn` |
| `memory_commit` | `{confirm: "<确认码>"}` 推进学习阶段（先调和，再提交）；`{abandon: true}` 丢弃草稿，不需要确认码。 | 主对话，学习阶段已打开 |
| `status` | 会话与项目状态（只读）。 | 主对话及其子智能体 |

每次会改变状态的调用，都必须由插件的 PreToolUse 钩子针对同一个 `tool_use_id` 做过认证。钩子没有生效时，`submit` 会拒绝执行，也不会启动任何验证。主会话的子智能体调用会被拒绝。如果磁盘上的插件代码不同于会话启动时的代码，或不同于正在运行的 MCP 服务器加载的代码，`submit` 也会以基础设施结果 `plugin_changed` 拒绝，不启动作业（见[隔离](#隔离哪些受保护哪些不受保护)）。

### 结束策略

结束钩子（`stop_policy`）会在以下情况出现时提醒 Claude 先别结束：验证仍在进行、学习阶段尚未关闭、工作区有改动但没有当前判定覆盖、经过验证的结果还没有学习。

- `nudge`（默认）：每种情况提醒一次。提醒以结束钩子反馈（`additionalContext`）的形式出现，而不是钩子错误。
- `gate`：每种情况在每条提示内最多阻止结束（`decision: block`）`interactive.stopGateMax`（3）次；“尚未学习”的提醒只阻止一次。针对未验证改动的阻止次数用完后，允许结束，并记为一次未验证的结束。
- `off`：从不提醒。

后台任务运行期间，每种情况最多提示一次，这条提示从不阻止结束，也不计入 `gate` 的次数；后台工作结束后再给出通常的提醒。在 `nudge` 策略下以及对后台提示而言，由提醒本身引发的结束（`stop_hook_active`）不会再次被提醒。

只有当工作区的 git 状态摘要与检查时记录的一致，判定才算*当前*有效。`node_modules`、`.venv` 和 `__pycache__` 下未跟踪的文件是派生缓存，不是候选内容：它们不计入这个摘要，也不进检查点（那里被跟踪的文件仍然算数），所以验证者的 `import` 或测试运行改写了缓存，不会让它的判定作废；验证者运行时还设置了 `PYTHONDONTWRITEBYTECODE=1`。过期的 `PASS` 不算数，`learn` 也会拒绝过期的判定。回滚模式下检查期间已有文件被改动的 `PASS`，无论改动来自验证者自己的命令（例如安装时改写了锁文件、测试时写入了快照）还是其他进程，从一开始就记为非当前有效：它的结果不带学习提示，`learn` 会拒绝它，状态里显示 `not current: the candidate changed during the inspection`。结果送达时，cc-rsi 会再检查一遍被恢复的文件：只有它们确实与候选结果一致时，NOTE 才这么说，否则会列出又出现差异的文件。如果同一批文件连续两次让同一个未改动候选结果的 `PASS` 作废，NOTE 会指出解决办法（提交重新生成的文件，比如更新后的锁文件；把缓存加进 `.gitignore` 或删掉它；停掉写这些文件的后台命令），而不是让 Claude 再 `submit` 一次。回滚模式下的验证者会被要求让已有文件保持逐字节不变，并在自己的临时目录里用副本做实验。

### 技能

| 技能 | 作用 |
|---|---|
| `/cc-rsi:status` | 记忆大小与完整性、冻结/封存标记、当前任务的验证状态、谱系。从不显示分数。Claude 也可以调用它。 |
| `/cc-rsi:explore …` | 探索谱系（见下一节）。只能由用户调用。 |
| `/cc-rsi:memory …` | `show [path]`、`inventory`、`history`、`log`、`verify`。只能由用户调用。 |
| `/cc-rsi:freeze` | 为 Phase 3 冻结记忆。只能由用户调用。 |
| `/cc-rsi:doctor [--live]` | 环境诊断。只能由用户调用。 |

解冻、恢复、放弃谱系和封存评测刻意没有对应的技能，它们只能在终端里执行。每个技能都带 `--report-exit` 运行命令行工具，所以退出状态以最后一行 `[cc-rsi exit N]` 的形式送达，Claude 可以解释阻碍项、失败的检查项和拒绝原因（注入的命令以非零状态退出时，Claude Code 会中止整个技能）。

## 探索谱系

一条谱系就是一个脱离会话的 Node 引擎。它为每条角色消息启动一个 `claude -p` 进程，同一个角色上下文的后续消息会恢复同一个会话，所有副作用都记录在一个带记忆化的操作日志里。记录保存在 `~/.cc-rsi/projects/<key>/lineages/<id>/`，角色的工作目录在 `~/.cc-rsi/work/<key>/<id>/`。执行者、验证者和课程智能体子进程各有自己的 `TMPDIR`；执行者另有一个私有临时目录（`actor-private/<episode>/scratch`），它的文件工具和 shell 命令都能使用。

| 阶段 | RSIAgent | 过程 | 结束方式 |
|---|---|---|---|
| `broad` | Phase 1 | 课程智能体编写一波彼此独立的练习项目及其输入文件树。harness 采集这些文件树，再把每个项目回放到全新的项目根目录。同一波的分支从同一份记忆快照出发并行运行（`waveConcurrency`，默认 2），每个分支都有全新的执行者和全新的验证者。整波结束后（波次屏障），各执行者在自己的上下文里按编写顺序**串行**蒸馏，每次都基于最新的记忆。因基础设施故障失败的分支会从不可变的输入文件重新开始，不计分。 | `saturated`、`stalled`、`budget_exhausted` |
| `deep` | Phase 2 | 一个全新的执行者尝试不变的目标。`PASS` 或 `FAIL` 结束这次尝试，由同一个执行者学习，并为课程智能体写一份诊断。`UNVERIFIED` 会要求提供证据线索。尝试停滞时先做一次强制检查，再在全新上下文里带着合成的工作日志续跑一次（可以换到升级模型，并把验证者换掉一次）。之后课程智能体选择练习项目（`DECISION: PROJECT`）、`READY_FOR_TARGET` 或 `STALLED`。只要做过练习，就必须重新尝试一次目标；`STALLED` 恰好换来一次最终目标测试。 | `verifier_pass`、`verifier_pass_curriculum_ready`、`verifier_pass_curriculum_stalled`、`curriculum_stalled_final_target_test`、`target_harness_unverified`、`budget_exhausted` |
| `frozen` | Phase 3 | 在冻结的记忆上尝试一次目标。`FAIL` 会把报告交还给同一个执行者修复（最多 `frozenRepairRounds` 轮，默认 8）。不学习，也没有课程智能体。 | `frozen_attempt_complete`、`target_harness_unverified` |

练习项目的候选结果（两个阶段都一样）会在执行者自己的项目根目录上，从不可变的采集结果重新回放一份来检查，所以 `<PROJECT_ROOT>` 对执行者和验证者指的是同一个路径；执行者自己的文件树在此期间暂存在谱系的私有记录里，检查完再放回原处。目标的候选结果则在完整检查点的保护下实时检查。

任何阶段都可能以 `quarantined`（泄漏绊线被触发）或 `abandoned` 结束。基础设施故障永远不是终局：谱系会以 `paused_infra` 暂停，`resume` 即可继续。这也包括 `plugin_changed`：每个角色子进程启动前，引擎都会把插件代码和谱系的基准比对，发生变化就暂停。

### 启动谱系

不带 `--yes` 的 `start` 只打印预检结果：计划、模型、隔离模式和所有阻碍项，不会启动任何东西。确认后加上 `--yes` 再运行一次。谱系 id 默认是 `<阶段>-<UTC 时间戳>`，可以用 `--id` 指定。

在 Claude Code 里：

```
/cc-rsi:explore start --phase broad --direction-file ideas.md
/cc-rsi:explore start --phase broad --direction-file ideas.md --yes
```

在终端里：

```sh
cc-rsi explore start --phase broad --direction "small text-processing CLI tools" --yes
cc-rsi explore start --phase deep --target-file task.md --fixtures ./inputs --yes
```

- `broad` 需要 `--direction` / `--direction-file`，或者一个带 `--target-conditioned` 的目标。`deep` 和 `frozen` 需要 `--target` / `--target-file`。`--fixtures DIR` 会在启动时被不可变地采集下来。
- `--model M` 同时设置执行者、验证者和课程智能体的模型；`--actor-model`、`--verifier-model`、`--curriculum-model`、`--escalation-model` 和 `--summarizer-model` 分别设置单个角色。未设置的角色依次取配置里的 `models.*`（包括已保存的插件选项 `verifier_model`）、会话模型（从会话里启动时）、`ANTHROPIC_MODEL`、`~/.claude/settings.json` 中的 `model`，最后是 Claude Code 的默认模型。解析出的模型会记录在 `lineage.json` 里。
- **没有操作系统沙箱时，`start` 会被拒绝**，除非你加上 `--allow-unconfined`（或在 `~/.cc-rsi/config.json` 里设置 `isolation.allowUnconfined: true`）。如果 `isolation.sandbox` 为 `require`（无论来自哪一层配置，包括已保存的插件选项 `sandbox`），即使加了 `--allow-unconfined` 也会被拒绝。详见[隔离](#隔离哪些受保护哪些不受保护)。最好在一次性的容器或虚拟机里运行。
- 启动时会发一次很小的模型调用，确认角色子进程能够完成认证（`--skip-auth-probe` 可以跳过）。
- `--foreground` 让引擎在当前进程里运行，而不是脱离出去。
- Claude 自己不能通过 Bash 工具启动或恢复谱系，把选项写在子命令前面也不行（除非全局配置 `exploration.modelMayStart` 为 `true`）。

### 跟踪与控制谱系

```sh
cc-rsi explore list                     # id、阶段、状态
cc-rsi explore status [<id>] [--json]   # 计数器、花费、隔离模式、暂停原因；从不显示报告正文或分数
cc-rsi explore log <id> [--follow] [-n N]
cc-rsi explore show <id>                # 各角色上下文，附 `claude --resume <sid> --fork-session` 提示
cc-rsi explore stop <id> [--timeout S]  # 发送 SIGTERM；引擎停止子进程并暂停（paused_user）
cc-rsi explore resume <id> [--accept-drift] [--foreground]
cc-rsi explore abandon <id> [--reason TEXT]   # 仅限人工；记录结束方式 "abandoned"
```

`stop` 在 `--timeout` 秒（默认 60）后升级为停止引擎的整个进程组。它只向本机上的引擎发信号：如果租约是同一台机器在旧主机名下写的，只要机器 id 一致，或者本地进程的命令行确实是这条谱系的引擎，就会被接受。

`resume` 会先做一次不写任何文件的准入检查。以下情况会被拒绝：谱系已经结束、引擎仍在运行、记忆被篡改、学习型谱系遇到已冻结或已封存的记忆库、插件代码有变化（加 `--accept-drift` 表示接受变化；此时会刷新谱系的提示词快照，并把接受的变化记录在 `lineage.json` 里）。根据暂停的位置，它会额外放行一次续写（活性暂停）、一轮证据补充（练习 `UNVERIFIED` 用尽）或四次提交尝试（提交次数上限）；其他暂停都会在原来的角色会话里重跑被中断的那一步。

`result.json` 使用 RSIAgent 的 snake_case 字段（`termination`、`target_verifier_verdict`、`curriculum_decision`、`candidate_digest`、树哈希、`official_evaluator_calls: 0` 等），方便和 RSIAgent 的记录对照。对 `deep` 谱系来说，最终候选结果就是验证者评判过的那棵文件树，在同一个执行者开始学习之前采集；`candidate_changed_after_verdict` 记录执行者在学习期间是否改动过它的实时项目根目录（`frozen` 为 `false`，`broad` 为 `null`）。`curriculum_decision` 是结束最后一轮演化的那个决定；如果那一轮被预算截断，则为 `null`。

## Phase 3：冻结、冻结谱系与封存评测

1. **冻结记忆**：`/cc-rsi:freeze` 或 `cc-rsi memory freeze`。此后交互模式的 `learn` 和新的 `broad`/`deep` 谱系都会被拒绝。解冻仅限人工：在终端运行 `cc-rsi memory unfreeze`。
2. **运行冻结谱系**：`cc-rsi explore start --phase frozen --target-file task.md [--fixtures DIR] --yes`。引擎会在尝试前后确认冻结的记忆树没有变化。
3. **配置评测器**，写在 `~/.cc-rsi/config.json` 里（只认全局配置，项目配置里的会被忽略）：

   ```json
   {"evaluation": {"command": ["python3", "/abs/path/grade.py"], "timeoutSec": 900, "retries": 2}}
   ```

   评测命令的工作目录是该谱系最终候选结果的一份新副本，环境变量经过白名单过滤，另外提供 `RSI_CANDIDATE_ROOT`、`RSI_TASK_FILE`（存放目标文本的文件），以及一个位于私有运行目录内的 `TMPDIR`（结束后删除；`HOME` 不变）。它必须把分数打印在 stdout 的最后一行：一个 JSON 数字或 `{"score": n}`。非零退出或超时会重试；同一个错误连续出现 3 次（`identicalErrorLimit`）则记为 `blocked`。如果候选结果里有指向树外的符号链接（目标是绝对路径、向上越出，或解析后落在树外），或者采集时只能原样复制整棵树，评测器根本不会启动：这次运行记为 `blocked`，附 `blocked_reason`，没有任何尝试记录。
4. **在终端里评测**：`cc-rsi eval run <lineage> [--retries N] [--json-out PATH]`。谱系必须是已经结束的 `deep` 或 `frozen` 谱系，且最终候选结果没有被改动过。只有 stdout 是终端时才会打印分数；否则只记录下来，之后用 `cc-rsi eval show <lineage> [--run R]` 查看，同样只在终端里显示。

封存评测会在记忆尚未冻结时先冻结它，在评测前后检查冻结的记忆树，并把记忆库标记为已封存。此后学习保持关闭，直到有人手动运行 `cc-rsi memory unfreeze --after-sealed`；之后的谱系结果会带上 `learning_after_sealed_evaluation: true`。

分数不会进入任何模型上下文：`eval` 拒绝在 Claude Code 内运行（`CLAUDECODE` 已设置），Claude 的 Bash 不能执行 `cc-rsi … eval`，Claude 的文件工具也不能访问 `~/.cc-rsi` 下除记忆视图、转发脚本和打开中的学习草稿以外的任何内容。`--json-out` 拒绝写到项目目录、项目的任何 git worktree、角色工作树、交互验证者的临时目录、谱系的候选根目录及其副本，以及封存运行目录里；按原样写法和解析符号链接之后的路径各比对一次。

## 配置

### 插件选项（`userConfig`）

在 Claude Code 的插件配置（`/plugin`）里设置，或者安装时用 `--config key=value` 设置。

| 选项 | 默认值 | 取值 |
|---|---|---|
| `verifier_model` | `""`（会话所用模型） | 别名（`opus`、`sonnet`、`haiku`、`fable`）或完整模型 id |
| `stop_policy` | `nudge` | `off`、`nudge`、`gate` |
| `sandbox` | `auto` | `auto`：沙箱可用就用，否则明确降级。`require`：没有沙箱就拒绝运行验证者和谱系子进程。`off`：从不使用沙箱 |

它们分别对应 `models.verifier`、`interactive.stopPolicy` 和 `isolation.sandbox`，构成下文优先级中的“插件选项”一层。只有你保存过的选项才算数；保存之前，更低的各层（包括 `~/.cc-rsi/config.json`）生效。cc-rsi 的各个部分从 Claude Code 提供它们的地方读取：

- **钩子**通过 `CLAUDE_PLUGIN_OPTION_*` 收到已保存的选项。SessionStart 会把它们记进会话记录；会话中途修改选项时，提示钩子和认证钩子会再次记录，所以下一次 `submit` 就用新值。
- **MCP 服务器**使用记录下来的选项。只要有钩子记录过，这份记录就是完整的，服务器自己的环境变量（`CC_RSI_OPT_*`）会被忽略：这些环境变量在服务器启动时就定下了，可能已经过时，而且对于没有保存的选项，Claude Code 也会把清单里的默认值放进去。因此过时的值永远不会覆盖你后来保存的选项（旧的 `sandbox=off` 不会把已保存的 `require` 降级），你清除的选项也保持清除。只有在没有任何钩子记录过选项时（钩子没有运行），服务器才使用自己的环境变量，并去掉与清单默认值相同的值，这样服务器、钩子和会话启动时的状态行看到的配置一致。
- **`cc-rsi` 命令行工具**（无论在终端还是技能里）读取 Claude Code 保存在 `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 中 `pluginConfigs` 下的选项：优先取当前插件来源市场对应的 `cc-rsi@<marketplace>` 条目；插件从目录运行（`--plugin-dir`）时取 `cc-rsi@inline`；都没有时取唯一的 cc-rsi 条目。任何一个 cc-rsi 条目里保存了 `sandbox: require` 都会生效。环境中的 `CLAUDE_PLUGIN_OPTION_*` 会覆盖保存的值。没有配置警告时，`cc-rsi doctor` 会在 `config` 这一行列出实际采用的选项及其来源。

### JSON 配置

| 文件 | 作用范围 |
|---|---|
| `~/.cc-rsi/config.json` | 全局（所有项目） |
| `<project>/.claude/cc-rsi.json` | 单个项目（有限制，见下文） |

优先级从低到高：内置默认值、全局文件、项目文件、非空的插件选项、命令行参数。键可以写成嵌套对象，也可以写成带点的字符串（`{"models.verifier": "opus"}`）。未知的键和无效的值会被丢弃并给出警告（`cc-rsi doctor` 会列出来）；无效值会退回到更低一层的设置。

- **G**（仅全局）：出现在项目文件里时会被忽略并警告。这样克隆下来的仓库就无法偷偷塞进评测命令、额外的环境变量、更弱的隔离，或者关掉泄漏绊线。
- **T**（只能收紧）：项目文件只能让取值更严格（`isolation.sandbox`：`off` < `auto` < `require`；网络白名单只能删除条目；`webTools` 只能关闭）。更严格的项目值甚至优先于插件选项和命令行参数。

| 键 | 默认值 | 说明 |
|---|---|---|
| `mode` | `"learn"` | `"frozen"`：Phase 3 复用（记忆库已冻结时也视为此模式） |
| `models.actor` / `verifier` / `curriculum` / `summarizer` | `""` | `""` 或 `"inherit"`：依次取会话模型、`ANTHROPIC_MODEL`、`~/.claude/settings.json` 中的 `model`、Claude Code 默认模型。总结者缺省时使用执行者的模型 |
| `models.escalation` | `""` | 停滞的目标执行者在全新上下文续跑时使用的模型。`""` 表示不升级 |
| `effort.actor` / `verifier` / `curriculum` / `summarizer` | `""` | 设置后作为 `--effort` 传入 |
| `interactive.enabled` | `true` | `false`：所有工具都拒绝并给出说明 |
| `interactive.taskMessages` | `3` | 验证者收到的最近用户消息条数（1–16） |
| `interactive.waitSeconds` | `100` | 单次调用的等待时间（10–110）；调用仍会及早结束等待，以便在 `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`（默认 120 秒）把它转入后台之前约 10 秒返回 |
| `interactive.allowUnverified` | `true` | 允许 `UNVERIFIED` 判定 |
| `interactive.verifierIdleHours` | `24` | 闲置超过这个时长后开启新的验证者上下文，并附上之前的报告 |
| `interactive.stopPolicy` | `"nudge"` | `off` / `nudge` / `gate` |
| `interactive.stopGateMax` | `3` | `gate` 模式下每种情况在每条提示内最多阻止的次数（0–8） |
| `interactive.baseline` | `true` | 任务开始时记录工作区的文件状态快照 |
| `interactive.rewake` | `true` | 判定落地时用异步钩子唤醒会话 |
| `interactive.checkpointMaxBytes` / `checkpointMaxFiles` | `268435456` / `20000` | 超过任一上限时检查点只做变更检测，不做恢复。项目文件里低于全局值（或默认值）的设置会生效，但会给出警告 |
| `isolation.sandbox` **T** | `"auto"` | `off` / `auto` / `require` |
| `isolation.allowUnconfined` **G** | `false` | 允许谱系在没有操作系统沙箱时运行 |
| `isolation.verifierNetwork` **T** | `[]` | 验证者沙箱的 `allowedDomains` |
| `isolation.actorNetwork` **T** | `[]` | 谱系执行者沙箱的 `allowedDomains` |
| `isolation.foreignMessageGuard` **G** | `true` | 角色子进程拒绝任何不是由 harness 发出的提示 |
| `isolation.verifierBashDeny` **G** | `true` | 对没有沙箱的验证者启用修改类命令的拒绝规则（git push、curl POST、ssh 等） |
| `transport.actionlessLimit` / `ceiling` | `3` / `24` | 连续无动作片段数 / 每个交接阶段的片段数上限，超过即活性暂停 |
| `transport.pauseSecs` / `pauseMaxSecs` | `30` / `300` | 临时性 API 错误的退避时间 |
| `transport.pauseCeilingSecs` | `{"interactive": 1800, "lineage": 21600}` | 临时性暂停的总时长上限 |
| `transport.retryWatchdog` | `true` | 在角色子进程里设置 `CLAUDE_CODE_RETRY_WATCHDOG=1` |
| `transport.watchdogMaxWaitMs` | `{"interactive": 1800000, "lineage": 21600000}` | `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` |
| `transport.turnTimeoutSec` | `{"actor": 14400, "verifier": 14400, "interactiveVerifier": 7200, "curriculum": 14400, "summarizer": 600}` | 每条角色消息的墙钟超时 |
| `transport.maxTurns` | `{"actor": 2000, "verifier": 2000, "curriculum": 2000, "summarizer": 1}` | 每次调用的 `--max-turns` |
| `transport.maxBudgetUsdPerMessage` | `0` | 大于 0 时作为 `--max-budget-usd` 传入 |
| `transport.compaction` | `{"practiceActor": "off", "targetActor": "auto", "verifier": "off", "curriculum": "off"}` | `off`：无损上下文（溢出算基础设施故障）；`auto`：使用 Claude Code 自动压缩，并重新钉住任务原文 |
| `transport.livenessNotes` | `true` | 角色重复执行相同命令并得到相同结果时给出提醒 |
| `exploration.waveConcurrency` | `2` | 每波并行分支数（1–8；RSIAgent 发布版为 4） |
| `exploration.waveCeiling` | `16` | 每波最多项目数 |
| `exploration.broadProjectBudget` | `12` | 在两波之间检查 |
| `exploration.deepPracticeBudget` / `targetCycleBudget` | `6` / `6` | `0` 表示不设上限（与 RSIAgent 一致） |
| `exploration.unverifiedRounds` | `3` | 目标：连续多少轮 `UNVERIFIED`（其间的证据工作没有任何工具动作）后判定尝试停滞。练习：多少次 `UNVERIFIED` 检查后谱系暂停（`unverified_exhausted`） |
| `exploration.unverifiedCeiling` | `8` | 紧急上限：同一个目标执行者上下文里累计多少轮 `UNVERIFIED` 后判定尝试停滞 |
| `exploration.targetResumes` / `branchRetries` / `frozenRepairRounds` | `1` / `1` / `8` | |
| `exploration.stopPolicy` | `"curriculum_review"` | 或 `"verifier_pass"`：第一次目标 `PASS` 就停止 |
| `exploration.curriculumMemoryAccess` | `"read_only"` | 或 `"none"` |
| `exploration.escalationHandoverReports` | `false` | 是否把之前的报告交给换上来的验证者（RSIAgent：不交） |
| `exploration.synthesizeWorklog` | `true` | 续跑时由总结者生成工作日志和策略复盘 |
| `exploration.webTools` **T** | `false` | 允许谱系执行者使用 WebFetch/WebSearch |
| `exploration.maxCostUsd` | `0` | `0` 表示关闭；在阶段边界检查，超出则以 `budget_exhausted` 结束 |
| `exploration.modelMayStart` **G** | `false` | 允许 Claude 的 Bash 运行 `cc-rsi explore start` 或 `resume` |
| `memory.dir` **G** | `""` | 覆盖记忆库的根目录：写绝对路径，或用 `~/…` 表示你的主目录。其他相对路径会被忽略并给出警告（改用默认记忆库）。位于 `~/.cc-rsi` 之外的记忆库与 `~/.cc-rsi` 一样是私有的（除非它包含项目目录）。位于项目内部的记忆库按路径仍是私有的，但搜索该项目不会因为覆盖到它而被拒绝；会话启动的状态行会给出警告，请把它移到项目之外 |
| `memory.maxFiles` / `maxTotalBytes` / `maxFileBytes` | `400` / `4194304` / `65536` | 提交上限；超限的草稿会交还给同一个执行者精简 |
| `memory.keepHistory` | `true` | 每次提交后保存记忆快照 |
| `memory.promptInventory` | `40` | 会话上下文里显示的记忆清单行数 |
| `audit.sealedTextFiles` **G** | `[]` | 用于 8 词片段泄漏绊线的留出任务文本或评分器源码 |
| `audit.shingleWords` **G** | `8` | 片段长度（3–16） |
| `evaluation.command` **G** | `[]` | 封存评测器的命令参数数组 |
| `evaluation.timeoutSec` / `retries` / `identicalErrorLimit` **G** | `900` / `2` / `3` | |
| `children.claudeBin` **G** | `""` | 角色子进程使用的 `claude`（默认使用正在运行的 Claude Code，否则用 `PATH` 上的 `claude`） |
| `children.envPassthrough` **G** | `[]` | 额外传给角色子进程的环境变量名（或 `PREFIX_*`） |
| `children.keepStreams` | `true` | 为每次角色调用保留 `stream.jsonl` |

设置 `CC_RSI_HOME` 可以把整个 `~/.cc-rsi` 目录挪到别处。

## 隔离：哪些受保护，哪些不受保护

每个角色子进程（验证者、谱系执行者、课程智能体、总结者）都以 `claude -p` 运行，带有 `--restricted --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk`、显式的工具列表、经过白名单过滤的环境变量（有工具的角色还有自己的 `TMPDIR`），不加载任何 MCP 服务器，并且每次调用都有一份单独的设置文件，里面是路径规则和一个失败即拒绝的角色守卫钩子。在此之上，实际使用的隔离模式会写进每一条判定和谱系记录：

| 模式 | 适用对象 | 含义 |
|---|---|---|
| `sandbox` | 沙箱可用时的验证者和谱系子进程 | Claude Code 沙箱包裹角色的 Bash：写入受限（验证者只能写自己的临时目录），隐藏路径不可读，网络只允许配置的域名（默认一个也没有）。交互模式的工作区仍然会打检查点并恢复；检查期间如果有外部因素改动了它，作业会以基础设施结果结束。 |
| `rollback` | 没有沙箱时的交互验证者 | 验证者在下面列出的守卫之下**无人值守地**运行 Read、Grep、Glob 和 Bash，每次检查后都从检查点恢复工作区。 |
| `unconfined` | 没有沙箱、且加了 `--allow-unconfined` 的谱系 | 执行者、验证者和课程智能体子进程**无人值守地**运行 Bash，只有下面的守卫。每次验证者检查后会恢复目标项目根目录；练习验证者检查的是在执行者项目根目录上重新回放的一份副本，检查完即丢弃。角色在这些根目录之外做的任何事都不会回滚。 |

> [!WARNING]
> **没有操作系统沙箱时，验证者和所有谱系子进程会以你的用户身份、在无人值守的情况下执行 Bash 命令，保护措施只有回滚和启发式规则。** Claude Code 沙箱在 Linux 上需要 `bubblewrap` 和 `socat`（macOS 上需要 `sandbox-exec`），在 WSL1 和很多容器里都不可用。此时：
>
> - 交互验证者降级为 `rollback`（会话启动时会提示）。在 git 仓库里，回滚恢复工作区根目录下被 git 跟踪、以及未跟踪且未被忽略的文件，但 `node_modules`、`.venv` 和 `__pycache__` 下未跟踪的文件除外；在 git 之外，恢复除 `.git`、`node_modules`、`.venv` 和 `__pycache__` 以外的所有文件（拒绝给你的主目录或 `/` 打检查点）。它**不会**撤销进程、服务、数据库、网络调用、`.git` 内部状态、被忽略的文件，以及工作区以外的任何东西。超过 256 MiB 或 20 000 个文件时只做变更检测。验证者会被告知它的检查点能恢复什么，基础设施结果会列出没有回滚的路径。
> - 不加 `--allow-unconfined` 时谱系会拒绝启动。无约束的谱系请在一次性的容器或虚拟机里运行。
> - 路径守卫和 Bash 扫描只是防止误操作和随手访问的启发式手段，不是安全边界。所有角色都以你的操作系统用户运行，通过混淆过的 shell 命令能读到你能读到的一切。
>
> 把 `sandbox` 设为 `require` 可以让它直接拒绝，而不是降级。

守卫覆盖的内容（都是启发式的，见上面的警告）：

- **cc-rsi 状态。** Claude 的文件工具不能访问 `~/.cc-rsi` 和外部 `memory.dir` 记忆库下的任何内容，只能读取记忆视图和转发脚本、使用打开中的学习草稿。它的 shell 命令也不能涉及这些路径：无论是直接写出、通过 `~`、`$HOME` 或相对路径、通过可能匹配到它们的通配符或花括号展开，还是通过起点在它们上层的递归遍历（`grep -r`、`rg`、`find`、`du`、`tree`、`ls -R`、`cp -r`、`rsync -a`、`tar` 等），包括写在 `sh -c` 和 `eval` 字符串里的命令。到达不了它们的遍历不会被拒绝：`rg`、`fd`、`ag`、`tree` 和 `ls -R` 在没有要求显示隐藏文件时会跳过 `~/.cc-rsi` 这样的点目录，`find -maxdepth`、`tree -L`、`rg --max-depth` 和 `fd -d` 在它们上方就停下。来不及检查完的超长命令会被拒绝；请拆开命令，或用 Write 工具写文件。转发脚本可以运行，但不能被改写。
- **插件代码。** 正在运行的插件（插件目录以及 `CLAUDE_PLUGIN_ROOT`）是只读的：Claude 的 Edit 和 Write 工具在那里被拒绝（Read 和 Grep 仍然可用），shell 命令只能把它作为要运行的程序，例如 `node <插件目录>/bin/cc-rsi …`。角色子进程同样只能读取它（文件工具，以及沙箱的写入规则）。SessionStart 会给插件的 `lib`、`hooks`、`bin`、`mcp` 和 `prompts` 计算指纹，MCP 服务器启动时也会给它加载的代码计算同样的指纹；此后代码一旦变化，`submit` 和验证作业都会以基础设施结果 `plugin_changed` 拒绝，谱系也会在下一个角色子进程启动前暂停（`plugin_changed`）。`/clear` 不会接受改动：MCP 服务器仍在运行，仍然与它加载的代码比对，只有重启 Claude Code 才会接受。如果会话的项目就是插件所运行的那份 cc-rsi 检出（或位于其中，即用 cc-rsi 开发 cc-rsi），这些规则不生效；安装在 Claude 配置目录下的插件始终受保护。
- **验证者对话记录。** 会话启动过验证者之后，它检查过的每个候选根目录对应的 Claude Code 对话记录目录（`~/.claude/projects/<slug>/`，以及 `CLAUDE_CONFIG_DIR` 下的同名目录）都不允许 Claude 的文件工具和 shell 命令访问，Claude Code 的自动记忆（`<slug>/memory`，也包括 `~/.claude/projects/*/memory/MEMORY.md` 这样的通配符）和本会话自己的记录文件除外；跨 `~/.claude/projects` 的搜索也会被拒绝，交给递归遍历或解释器的上层目录同样会被拒绝。只是提到配置目录本身的命令（`ls ~/.claude`、`cd ~/.claude`、把文件复制进去、提交说明）不会被拒绝。每次 `--resume` 之前，作业都会把对话记录与上一个作业记录的指纹比对；记录被改动过时，旧上下文退役，新上下文带着之前的报告重新开始。
- **执行者的推理痕迹。** 所有角色子进程都不能访问 `~/.claude` 和 `$CLAUDE_CONFIG_DIR` 下的 `projects`、`.credentials.json`、`plans`、`todos`、`tasks`、`file-history` 和 `history.jsonl`，会话临时目录 `<TMPDIR>/claude-<uid>` 和 `/tmp/claude-<uid>`，cc-rsi 自己的状态（`projects`、`run`、`bin`、`config.json`、`logs`、其他谱系的工作树、交互验证者的临时目录），以及外部记忆库。`shell-snapshots` 和 `session-env` 仍然可读，因为角色自己的 Bash 要加载它们；角色自己的临时目录（`TMPDIR`，即其临时目录下的 `.tmp`）和它自己的 Claude Code 会话目录（大型工具结果保存在那里）也可读：包含它的隐藏目录在权限规则和沙箱里绕开它逐项拒绝（另外拒绝其下所有对话记录 `*.jsonl`），所以 Read 和 Bash 都能读到角色自己的工具结果。

在任何模式下都成立的其他限制：

- 有沙箱时，沙箱也只包裹 Bash；钩子、Claude Code 本身和文件工具由权限规则和角色守卫约束。
- 规范记忆、验证者报告、验证者对话记录和插件代码做的是**篡改检测**，而不是防篡改：每个敏感步骤之前都会把记忆树哈希和最后一次提交比对，报告在读取时会重新计算哈希，对话记录在 `--resume` 之前比对指纹，插件代码在会话启动时和 MCP 服务器启动时记录指纹。
- 没有操作系统沙箱时，角色的 Bash（谱系子进程，或回滚模式下的交互验证者）仍然可以改写插件代码。这种改动会在下一个谱系角色子进程启动前被发现（谱系暂停）；对交互验证来说，则在下一次 `submit` 和作业启动时被发现。
- 角色的对话记录和普通会话一样存放在 `~/.claude/projects/`。交互验证者的会话和你的项目共用同一个记录目录，可能出现在会话选择器里；只有守卫在阻止 Claude 访问它们。

## 命令行参考

```
cc-rsi status [--json] [--session <sid>] [--project <dir>]
cc-rsi doctor [--live] [--json] [--session <sid>] [--release-lock <root>*]
cc-rsi memory show [<rel>] | inventory | history | log [-n N] | verify [--accept-external*] | restore <N>*
              | freeze | unfreeze [--after-sealed]* | export <dir> | import <dir>* | drafts [--prune*]
cc-rsi explore preflight|start <start options> | status [<id>] [--json] | log <id> [--follow] [-n N]
              | stop <id> [--timeout S] | resume <id> [--accept-drift] [--foreground]
              | abandon <id> [--reason TEXT]* | show <id> | list
cc-rsi eval run <lineage> [--retries N] [--json-out PATH]* | eval show <lineage> [--run R]*
cc-rsi verify cancel [--session <sid>] [--grace SECONDS]*
cc-rsi gc [--older-than DAYS] [--dry-run] [--streams] [--project <dir> [--session <sid>]]
cc-rsi version | help
```

带 `*` 的是仅限人工的命令：在 Claude Code 内运行会被拒绝（退出码 65），并打印 `in a terminal, run: <命令>`；Claude 的 Bash 也不能执行它们（守卫会解析命令，所以只是提到它们的提交说明、议题标题或路径不会被拒绝；同时清除 `CLAUDECODE` 的命令，比如带 `env -u CLAUDECODE`、`env -i`、`unset CLAUDECODE` 或 `CLAUDECODE=` 的命令，只要文本里出现 `cc-rsi` 后跟仅限人工的子命令就会被拒绝，因为解析出的命令词可能漏掉计算出来的命令词）。大多数命令接受 `--project <dir>`（默认是当前目录所在的项目）。退出码：0 成功，1 错误，2 用法错误，3 被阻碍项拒绝，64 在角色子进程内，65 仅限人工。`--report-exit` 写在命令词之后时，命令行工具会把 `[cc-rsi exit N]` 作为 stdout 的最后一行打印出来并以 0 退出（技能就是这样用的）；在角色子进程内仍然以 64 退出。`cc-rsi help` 打印完整用法，包括配置的优先级。

- `memory verify` 把规范记忆和最后一次提交比对。如果它在提交之外被改过，`--accept-external` 把这次改动记为一次提交，`restore <N>` 回滚到第 `N` 个历史快照（见 `memory history`）。记忆处于冻结状态时，外部改动不能被接受；此时 `memory verify` 会指出能恢复冻结记忆树的那个 `restore <N>`。
- `memory export <dir>` / `import <dir>` 把记忆导出到记忆库之外，或从外部导入（导入会记为一次提交）。
- `memory drafts --prune` 只删除无人能继续的草稿：所有者已不在或回合已提交的草稿，以及学习阶段已不再打开的会话草稿。正在运行或已暂停的谱系的草稿始终保留。
- `verify cancel` 停止正在进行的交互验证。作业会恢复工作区，并记为基础设施结果 `cancelled`，而不是判定。只有当某个 pid 被确认为本机上的这个作业时（依次依据记录的进程启动标记、命令行、不超过 90 秒的心跳）才会向它发信号；否则命令拒绝执行（退出码 3），并说明如何手动停止。`--grace` 秒（默认 60）之后，如果作业是自己进程组的组长，就停止整个进程组。
- `doctor --release-lock <root>` 删除 `<root>` 的工作区锁及其所有恢复失败标记。锁仍然存活且并非恢复失败时（30 秒内续约过，或持有者是本机上存活的进程），它会拒绝执行。

## ~/.cc-rsi 目录与 gc

cc-rsi 把状态放在所有工作区之外，也不放在 Claude Code 的插件数据目录里，所以卸载插件后记忆依然保留。

```
~/.cc-rsi/
  config.json                    全局配置
  probe.json                     沙箱探测结果缓存
  bin/cc-rsi                     终端转发脚本
  logs/                          hooks.log、mcp.log、cli.log、jobs.log
  run/                           认证记录、工作区锁及恢复失败标记、按内容寻址的子进程设置、
                                 提示词和策略、会话索引
                                 （没有 /etc/machine-id 时，机器标识保存在
                                 /var/tmp/cc-rsi-<uid>/machine-id，绝不放在这个可能共享的目录里）
  vscratch/<verifierSessionId>/  交互验证者的临时目录（其中的 .tmp/ 是它的 TMPDIR）
  work/<key>/<lineage>/          谱系角色的工作目录（角色可见），执行者的私有临时目录
                                 在 actor-private/<episode>/scratch
  projects/<key>/                每个项目一个目录（<key> = <名称>-<根路径哈希前 12 位>）
    store/                       规范记忆、日志、历史、报告、冻结/封存标记
    sessions/<sid>/              任务状态、采集的请求、自行安排的提示清单、验证作业及日志、
                                 判定、检查点、被挪开的文件副本
    views/<sid>/memory/          提供给主会话的只读记忆视图
    drafts/<episode>/            交互学习草稿
    lineages/<id>/               lineage.json、state.json、ops.jsonl、events.jsonl、result.json、engine.log、priv/
    sealed/<lineage>/<run>/      封存评测运行记录（evaluation.json）
```

项目指的是 git 公共目录的上一级目录，所以同一仓库的所有 worktree 共用一份记忆。全局配置 `memory.dir` 可以把记忆库挪到别处。

`cc-rsi gc [--older-than DAYS] [--dry-run] [--streams] [--project <dir> [--session <sid>]]` 只删除派生的和临时的数据：超过一小时的认证记录；结束超过 `DAYS` 天（默认 14）的会话，或者从未记录 SessionEnd（被杀掉、崩溃）且 `DAYS` 天内没有任何活动的会话的视图、检查点、被挪开的副本和验证者调用日志；已关闭或已退役任务的旧验证者临时目录；已结束谱系的工作树；加上 `--streams` 时还包括已结束谱系的调用流。记录（任务状态、判定、日志、结果、报告、评测）永远不会删除，正在运行的作业、存活的引擎或工作区锁可能用到的内容也会保留。`--project` 把 gc 限定在一个项目，`--session` 限定在一个会话；此时不做全局清理（认证记录、验证者临时目录）。删除失败的路径会被报告（权限错误时附 `chflags` 或 `lsattr` 提示）并跳过；gc 继续处理其余内容，最后以 1 退出。

## 故障排查

先运行 `/cc-rsi:doctor`（或在终端里运行 `cc-rsi doctor`）。每项检查都会打印 `PASS`、`WARN` 或 `FAIL` 以及写明真实路径（`<home>/config.json`、`<project>/.claude/cc-rsi.json`）的处理建议，覆盖：Node、`claude` 的版本和必需参数、git、`~/.cc-rsi`、终端转发脚本和 `PATH`、记忆完整性、未完成的提交和被遗弃的草稿、工作区锁（包括等待恢复的已退出作业，doctor 也会启动它们的恢复）、引擎已退出或已暂停的谱系、沙箱、钩子在会话中是否生效、MCP 服务器的工具列表、模型和配置警告。

`cc-rsi doctor --live` 会额外发出几次很小的真实模型调用（两次，有沙箱时三次）：用和角色子进程完全相同的参数与环境做一次认证探测；在第一条消息和 `--resume` 上各做一次钩子探测；静态探测通过时再做一次沙箱实测。沙箱实测只有在确认测试命令确实运行过时才报告是否生效；否则报告 `WARN`（无法判定）。

| 现象 | 原因与处理 |
|---|---|
| 终端里提示 `cc-rsi: command not found` | 还没有会话写出转发脚本，或者它所在的目录不在 `PATH` 上。`/cc-rsi:doctor`（检查项 `shim`）会打印 `export PATH=…` 行。在此之前可以运行 `node "<插件目录>/bin/cc-rsi" …`，也就是仅限人工的命令被拒绝时打印的那条命令。 |
| `submit` 提示 "cannot attest this call" | 插件的钩子在这个会话里没有运行（`disableAllHooks`、`allowManagedHooksOnly`，或插件被禁用）。在该会话里运行 `/cc-rsi:doctor`，它会检查钩子有没有采集到你的请求。 |
| 验证以 `INFRASTRUCTURE: … (auth)` 结束 | 角色子进程使用 `--restricted`，会忽略你的设置文件。cc-rsi 会从 `~/.claude/settings.json`（或 `$CLAUDE_CONFIG_DIR/settings.json`）转发 `apiKeyHelper`、`awsAuthRefresh`、`awsCredentialExport`、`forceLoginMethod`、`forceLoginOrgUUID` 和提供商相关的 `env` 条目，并从环境中传入 `ANTHROPIC_*`、`AWS_*`、`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`、`CLAUDE_CODE_OAUTH_TOKEN`、代理和 CA 相关变量。其他变量可以通过 `children.envPassthrough` 添加。用 `cc-rsi doctor --live` 确认。 |
| `INFRASTRUCTURE: … (config)` | 模型名被拒绝；检查 `verifier_model` / `models.*`。 |
| `INFRASTRUCTURE: … (plugin_changed)` | 会话启动之后插件代码发生了变化（更新或改动）。重启 Claude Code：开新会话，或用 `--resume`/`--continue` 继续这个会话（`/clear` 不够：MCP 服务器保留着它加载的代码）。重启后的会话接受它加载的代码，并在启动状态行里说明。编辑器的交换文件和 `.DS_Store` 不算代码。 |
| `INFRASTRUCTURE: … (candidate_changed_during_inspection)`，或者某个 `PASS` 的 NOTE 说它不算当前有效 | 检查期间有检查以外的东西改动了工作区，通常是 `submit` 之前启动的后台进程；在回滚模式下也可能是验证者自己的命令。先停掉这类进程，再让 Claude 重新提交。如果 NOTE 说同一批文件在同一个候选结果的上一次检查中也被改动过，先让它们稳定下来（提交重新生成的文件、忽略或删掉缓存、停掉写入者）。 |
| Claude 的编辑被拦下："an independent verification of this workspace is running" | 作业运行期间这是正常的。Claude 应该调用 `wait_verdict`；你也可以用 `cc-rsi verify cancel` 取消。如果提示说某个作业 "ended without restoring its checkpoint"，说明它的恢复正在进行：稍后重试即可（`cc-rsi doctor` 会显示为等待恢复）。 |
| "a verification failed to restore the workspace" | 工作区锁被故意保留。先检查 `~/.cc-rsi/projects/<key>/sessions/<sid>/displaced/<job>/` 下被挪开的副本，再在终端运行 `cc-rsi doctor --release-lock <root>`（它也会删除恢复失败标记）。 |
| `verify cancel` 提示作业 "is not cancelled" | cc-rsi 无法证明这个 pid 就是作业（启动标记不匹配、命令行不可读、心跳超过 90 秒），所以不发任何信号。请自行确认该 pid 并用 `kill` 停止，或者等下一次会话启动、`submit` 或 `status` 去恢复这个作业。 |
| Claude Code 读取记忆视图时弹出权限确认 | 守卫会预先放行对视图和打开中草稿的读取，但这一点尚未在真实的 Claude Code 上验证。可以把 `Read(~/.cc-rsi/projects/*/views/**)`（学习时还有 `Edit(~/.cc-rsi/projects/*/drafts/**)`）加入权限允许规则。 |
| 学习阶段已打开，但 Claude 丢了确认码（例如上下文压缩之后） | `learn` 会重新给出当前阶段的消息和确认码；`memory_commit` 带 `abandon: true` 可以不用确认码直接丢弃草稿。上下文压缩或恢复会话后，SessionStart 会提醒 Claude 有一个打开中的学习阶段。 |
| `memory changed outside a commit` | `cc-rsi memory verify` 会显示差异。用 `cc-rsi memory verify --accept-external` 保留改动，或用 `cc-rsi memory restore <N>` 回滚。记忆处于冻结状态时只能用恢复，`memory verify` 会指出对应的快照。 |
| 谱系处于 `paused_infra` | `cc-rsi explore status <id>` 会显示故障类别和细节。排除原因后运行 `cc-rsi explore resume <id>`。`context_lost` 表示某个执行者或课程智能体的对话记录已经不在了（例如被 Claude Code 的 `cleanupPeriodDays` 清理）；这个上下文无法继续，只能放弃该谱系。`plugin_changed` 表示谱系运行期间插件代码发生了变化；确认改动后加 `--accept-drift` 恢复。`candidate_capture_mismatch` 表示目标验证者评判过的那棵树的副本与它不一致，因此不计分；由较早的 cc-rsi 版本启动、项目根目录里有特殊文件（FIFO、套接字）的目标尝试，每次恢复都会在这里再次暂停，这样的谱系请放弃。 |
| `resume refused: the plugin changed since the lineage started` | 谱系开始之后插件被更新了（或者它运行过的版本目录被清理了）。加 `--accept-drift` 用当前代码继续（会记录在 `lineage.json` 里，并刷新提示词快照；更新前已发送的消息即使在新模板下措辞不同，也会重放记录下的回复）。 |
| `explore stop` 拒绝执行：引擎 "runs on host …" | 引擎租约写的是另一台主机，cc-rsi 无法证明这个 pid 就是这条谱系的引擎。在运行它的机器上用 `ps -p <pid> -o command=` 确认后在那里停止（如果就在本机，用 `kill <pid>`）。 |

日志位置：`~/.cc-rsi/logs/`、会话目录下的 `jobs/<job>.log`、谱系目录下的 `engine.log`，以及 `ctx/` 目录下每次角色调用各自的目录（`prompt.md`、`stream.jsonl`、`stderr.txt`、`guard.jsonl`、`meta.json`）。

## 版本与更新

`.claude-plugin/plugin.json` 里有 `version` 字段（当前为 `0.1.0`）。Claude Code 按这个版本号而不是提交来安装和更新，所以**每次发布都必须提升版本号**；不提升版本号就推送的提交不会到达已安装的用户。`cc-rsi version` 会打印版本号和当前使用的插件目录，MCP 服务器报告的也是同一个版本号。（规范原本不写 `version`，让安装跟随提交，但 `claude plugin validate --strict` 要求必须有。）

## 开发

```sh
npm test                                   # node scripts/run-tests.mjs：运行 test/e2e 以外的所有 test/**/*.test.mjs
node scripts/run-tests.mjs test/engine     # 只运行一个目录或文件
node scripts/run-tests.mjs test/hooks --test-name-pattern guard   # node 参数保留各自的取值
npm run smoke                              # CC_RSI_E2E=1：真实的 claude，--model haiku，会消耗 token
CC_RSI_E2E_FULL=1 npm run smoke            # 额外运行“SIGTERM 后恢复”的谱系场景
claude plugin validate . --strict          # 检查清单、钩子、MCP 和技能
claude --plugin-dir .                      # 在会话里试用当前工作树
```

- 没有任何运行时依赖；测试只用 `node:test`，从不访问 `~/.cc-rsi`、你的 Claude Code 配置（每个临时 home 都有自己的 `CLAUDE_CONFIG_DIR`）或网络。角色子进程在一个假的 `claude`（`test/fake-claude/`）上测试，它模拟了 stream-json、会话语义、崩溃，并会真实执行钩子。
- `TMPDIR` 含空格或非 ASCII 字符时测试也能运行；被中断（SIGINT/SIGTERM）时会清理临时目录；以 root 运行时，如果 uid 65534 无法访问 `TMPDIR`，少数需要非特权用户的测试会被跳过。
- 引擎的崩溃矩阵（`test/engine/crash-matrix.test.mjs`）在一次参考 broad 运行、一次分支不计分重来的 broad 运行和一次参考 deep 运行的每一个记入日志的操作处制造异常或杀死进程，检查恢复后能得到与不中断时相同的结果。`CC_RSI_CRASH_LANES=N` 限制并行度；`CC_RSI_CRASH_MATRIX=full` 还会在每个操作开始时注入故障，并增加一次带练习项目的 deep 运行。
- 提示词黄金文件：有意修改提示词之后，运行 `CC_RSI_UPDATE_GOLDENS=1 node scripts/run-tests.mjs test/prompts/render.test.mjs`，再审阅差异。
- `test/plugin/boundaries.test.mjs` 强制检查模块的导入边界；只有 `lib/runtime/child.mjs` 可以启动 `claude`。

当前状态：`npm test` 运行 775 个测试，全部通过；`claude plugin validate . --strict` 通过，没有警告。包含额外场景的真实模型冒烟测试（`CC_RSI_E2E_FULL=1 npm run smoke`，Claude Code 2.1.296，haiku）的六个场景全部通过：准备、`doctor --live`、经由插件的交互 `submit`、一条 broad 谱系、一条在波次中途被停止后又恢复的 broad 谱系，以及冻结加冻结谱系加封存评测。详情见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#verify-early-outcomes)。

## 已知限制

以下问题在最近一次审查后仍然存在；对每一项，cc-rsi 只能发现或限制它，而不能阻止它。

1. **后台进程不会被停止。** 工作区锁只暂停 Claude 新发起的编辑和命令，不影响 `submit` 之前启动的进程。它们造成的改动在检查结束后才被发现（沙箱：不产生判定；回滚：`PASS` 不算当前有效），而且它们仅新建的文件不计入。在回滚模式下，验证者自己的命令造成的改动看起来一样，也会让 `PASS` 不算当前有效（`node_modules`、`.venv` 和 `__pycache__` 下未跟踪的派生缓存除外）。
2. **没有沙箱的角色可以通过 Bash 改写插件代码。** 没有操作系统沙箱时只有它们的文件工具被拒绝；改动会在下一个谱系角色子进程启动前以及下一次 `submit` 时被发现，但无法阻止。
3. **守卫是启发式的。** 所有角色和你的会话共用一个操作系统用户；Bash 扫描能挡住误操作和随手访问，挡不住混淆过的命令。最近一次审查还有三项发现没有修复。被认为会跳过点目录的 `rg` 遍历，在带 `--hidden` 的 ripgrep 配置（`RIPGREP_CONFIG_PATH`）下或带 `-g`/`--iglob` 通配符时仍会进入它们；限制了深度的 `find` 没有考虑它的 `-exec` 或管道后的 `xargs` 发起的遍历；因此这类命令可以读到 `~/.cc-rsi` 和验证者对话记录。对话记录规则看不到通过 here-document 交给解释器的代码（`python3 - <<'EOF'`）、在同一条命令里创建并读取的指向对话记录目录的链接，也看不到对它的 `git diff --no-index`。here-document 文本中以仅限人工的 `cc-rsi` 命令开头的行仍会被当作命令解析，所以这样的提交（Claude Code 的提交说明模板、PR 正文、变更日志）会被拒绝。
4. **只做变更检测的检查点不恢复任何东西。** 超过 `interactive.checkpointMaxBytes` / `checkpointMaxFiles` 时，验证者会被告知不会恢复任何东西，结果会列出发生变化的路径。
5. **没有 `source` 的提示。** Claude Code 省略 UserPromptSubmit 的 `source` 字段时，只有与本会话中成功的 CronCreate、ScheduleWakeup 或 RemoteTrigger 调用的提示文本（去掉首尾空白后）完全一致、且该安排仍可能触发的提示，才会被认出是 Claude 自己安排的。在此期间你亲手输入同样的文本，也会被当作安排的提示。还没有任何任务列表列出过的安排，在被删除或满 8 天之前都算仍可能触发。
6. **尚未在真实环境中验证：** 异步唤醒空闲会话、记忆视图的权限预先放行（后备方案分别是 `wait_verdict` 和手动添加允许规则）、沙箱模式的运行和 Node 18。
7. **规范文档滞后。** `docs/design/SPEC.md` 还没有随最近的修复更新；[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#recorded-deviations-from-the-specification) 列出了代码现在与它不同的地方。

## 与 RSIAgent 仍然存在的差异

完整列表及原因见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#remaining-differences-from-rsiagent)。简要来说：

1. 没有虚拟机。有 Claude Code 沙箱时用沙箱，否则依靠权限规则、启发式守卫和检查点恢复。
2. 所有角色共用你的操作系统用户；守卫防的是误操作，篡改检测只能发现改动，不能阻止。
3. 回滚只覆盖工作区根目录下的文件。
4. 交互模式是扩展：执行者就是你的会话，它可以不调用 `submit`，任务内容是你最近的几条消息。
5. 证据线索原样交给验证者，不会被执行；RSIAgent 的完成检查关卡没有移植。
6. 交接内容是最后一条助手消息，而不是文件。
7. 传输层恢复会在角色的对话里加入一条可见的恢复说明。
8. 目标执行者使用 Claude Code 的上下文压缩并重新钉住任务原文，而不是 RSIAgent 的折叠总结器。
9. 预算默认有上限（deep 6/6，每波上限 16，并行度 2）。
10. 恢复是基于操作日志的通用 `resume`，而不是针对具体事故的方案。
11. 练习分支共用同一台主机。
12. 除非你配置模型，否则没有跨模型的不对称性。
13. 考试防护简化为 8 词片段泄漏绊线。
14. 阶段顺序按记忆库强制（冻结、封存），用 `--yes` 代替 ACK 令牌。
15. 部分 RSIAgent 功能没有移植（见证关卡、Look 集成、统一循环路由、验证者预热阶段等）。
16. 记忆按项目存放，由交互学习和谱系共用。
17. 角色的对话记录存放在 Claude Code 自己的记录目录里。
18. 只支持 POSIX。

## 致谢与引用

cc-rsi 经由 [dsh-rsi](https://github.com/mutsuki14/dsh-rsi)（Apache-2.0）移植自 [RSIAgent](https://github.com/AetherLabsAI/RSIAgent)（Apache-2.0）。[NOTICE](NOTICE) 列出了改编自它们的文件。如果你使用了 cc-rsi，请引用 RSIAgent：

```bibtex
@misc{zhu2026rsiagentautonomousexplorationrecursive,
      title={RSIAgent: Autonomous Exploration for Recursive Self-improvement in New Environments},
      author={Sibo Zhu and Shicheng Fan and Xinyue Wang and Wenyi Wu and Kun Zhou and Biwei Huang},
      year={2026},
      eprint={2609.15364},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2609.15364},
}
```

## 许可

[Apache License 2.0](LICENSE)。
