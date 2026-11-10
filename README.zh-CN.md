# MemoryCode

<p align="center">
  <img src="./docs/logo.svg" alt="MemoryCode Logo" width="180" />
</p>

<h2 align="center">MemoryCode</h2>

<p align="center">
  <img src="https://img.shields.io/badge/Editor-MemoryCode-D97757?style=for-the-badge" alt="Editor: MemoryCode" />
  <img src="https://img.shields.io/badge/%23memorycode-%E9%A1%B9%E7%9B%AE-B85C3F?style=for-the-badge" alt="#memorycode" />
  <img src="https://img.shields.io/badge/%E9%95%BF%E6%9C%9F%E8%AE%B0%E5%BF%86-%E6%A0%B8%E5%BF%83%E7%89%B9%E6%80%A7-F0EBE1?style=for-the-badge&labelColor=8B8B8B" alt="长期记忆：核心特性" />
  <img src="https://img.shields.io/badge/%E7%9F%A5%E8%AF%86%E5%9B%BE%E8%B0%B1-F0EBE1?style=for-the-badge&labelColor=8B8B8B" alt="知识图谱" />
</p>

---

<p align="center">
  一个带长期记忆的轻量级终端编码助手。它记得你的项目、你的决策、你的纠正——跨会话依然有效。
</p>

[English](./README.md) | [详细使用指南](./USAGE_ZH.md) | [架构说明](./ARCHITECTURE_ZH.md) | [贡献规范](./CONTRIBUTING_ZH.md) | [路线图](./ROADMAP_ZH.md) | [License](./LICENSE)

MemoryCode 是一个内置长期记忆的终端编码助手。

它保留了轻量的类 Claude Code agent-loop 架构，并加入了一套知识图谱记忆系统：每次会话沉淀下的事实、事件、经验教训和技能，会在之后的会话中自动检索复用。因此它既适合在长期维护的项目里做日常开发，也适合用来学习一个"记忆优先"的 Agent 是如何构建的。

## 项目简介

MemoryCode 同时运行着两个循环：

**Agent 循环**（terminal-first，逐轮推进）：

- 接收用户请求
- 检查当前工作区
- 在需要时调用工具
- 修改文件前先 review
- 在同一个终端会话里返回最终结果

**记忆循环**（在底层持续运行，跨会话生效）：

- 模型回答前，先检索相关记忆
- 每轮结束后，记录本轮实际发生了什么
- 把事实、事件和观点抽取进知识图谱
- 新旧事实互相校对（合并、取代或归档）
- 定期整合会话，蒸馏出可复用的技能

整个项目有意保持紧凑，让主控制流、工具模型、记忆管线和 TUI 行为都更容易理解和扩展。

## 为什么选择 MemoryCode

MemoryCode 适合你，如果你想要：

- 一个能记住你的技术栈、项目约定和纠正意见的助手，而不是每次对话都从零开始
- 一套有真实生命周期的记忆：事实有版本链，冲突按陈述时间裁决，过时记录被归档而不是悄悄共存
- 从你真实成功与失败中生长出来的技能，带基于使用情况的适应度评分和淘汰机制
- 一个轻量级 coding assistant，而不是庞大的平台
- 一个很适合阅读和二次开发的小代码库

## 核心能力

### 长期记忆

- 受 CogMem 启发的知识图谱：`Person`、`Event`、`Concept`、`Claim`、`Fact` 五类节点，通过带类型的关系边（`SUPERSEDED_BY`、`SUPPORTED_BY`、`PARTICIPATED_IN` 等）连接，每条记录最多保留 3 段逐字原文证据。
- 每轮自动检索：回答前自动查找相关记忆并注入上下文；`/memory` 可查看本轮实际加载内容与持久记忆健康报告。
- 事实生命周期建立在时间双轴上：`stated_at`（用户最近一次陈述的时间——新旧裁决的唯一依据）与 `effective_from`（事实在世界中开始为真的时间——仅用于展示与追溯）。新陈述通过显式 `SUPERSEDES` 链取代旧陈述，被归档的事实会移出向量索引。
- 冲突校对：近似重复的事实自动合并（相似度 ≥ 0.95），同主体的更新形成版本链（相似度 ≥ 0.80），模糊冲突交给 LLM 批量确认，谓词先做同义归一（`lives_in`/`resides_in`/`moved_home` → `lives_in`），换措辞的更新也能匹配上。
- 显式作废：当用户宣布之前的记录不再成立时，旧事实会被归档，而不是与新事实默默共存。
- 事实只来自用户：只有用户陈述（或用户确认的结果）才会成为事实，Assistant 自身的推理永远不会回写成记忆。抽取阶段禁止记录密钥、token 和绝对路径。
- 防谎报守卫：回复里声称"已记录/已更新/已作废"但本轮没有任何成功的 `memory_write`/`memory_forget` 调用时，会被标记为 `unbacked-memory-claim`。
- 三层记忆结构——`episodic`（情景）、`semantic`（语义）、`procedural`（程序性），并带持久性分级（`durable` / `session` / `volatile`），底层由本地向量库加 embedding 支撑语义检索。
- 专用工具：`memory_read`（检索图谱记忆）、`memory_write`（沉淀程序性经验）、`memory_forget`（带理由的软删除）。

### 技能生命周期（SkillForge）

- 技能保存在持久化的 skill bank 中，生命周期为 `trial → active → stable → retired`，由使用次数和成功次数追踪。
- 检索时把成熟技能与留给 trial 技能的探索名额混合曝光。
- 周期性进化：按适应度晋升、降级、淘汰和固化；反复出现的失败会被分析成新的候选技能（变异）。
- 增量蒸馏带闸门控制（bank 容量、trial 池饱和度），避免技能池被稀释；retired 墓碑数量有上限，保证 bank 不会无限增长。
- 与技能一起沉淀的还有 `common_mistakes`（常见错误清单）。

### Agent 核心

- 单轮支持多步工具执行，形成 `model -> tool -> model` 闭环。
- 支持最多 3 个并发的只读 sub-agent；root agent 统一修改代码，并可等待或主动关闭 worker。
- 支持同一会话内跨 root 回合共享的内存 Todo 清单，Agent 通过 `update_plan` 更新，用户通过 `/plan` 查看。
- 支持用户创建的进程内 Goal，跨回合自动推进，提供暂停、恢复和显式完成检查。
- 支持单个进程内 Loop，在每轮完成后按固定间隔重复提示词，可共用 Plan，并与启用中的 Goal 互斥。
- 提供全屏终端交互界面，支持输入历史、transcript 滚动、slash 命令菜单和审批交互。
- 会话按项目隔离持久化，支持恢复、重命名、分叉和压缩。
- 上下文统计优先使用 provider usage，并支持 tail estimate、自动压缩、上下文折叠和裁剪压缩。
- 内置文件、搜索、编辑、命令执行、Web fetch/search、澄清提问等工具。
- 支持通过 `SKILL.md` 发现本地 skills，也支持通过 stdio 或远程 HTTP 接入 MCP tools/resources/prompts。
- 文件修改前先 review diff，并对路径和命令执行做权限检查。
- 超大工具结果会落盘保存，并在上下文里替换成短预览和文件路径，减少长输出对对话空间的挤占。

完整命令、配置示例、会话机制和 Skills/MCP 用法已经移到 [详细使用指南](./USAGE_ZH.md)。

## 安装

```bash
git clone https://github.com/besfofyou/MemoryCode.git
cd MemoryCode
npm install
npm run install-local
```

安装器会询问模型名称、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`。默认配置保存在：

- `~/.memory-code/settings.json`
- `~/.memory-code/mcp.json`

可通过 `MEMORY_CODE_HOME` 自定义配置目录，通过 `MEMORY_CODE_BIN_DIR` 自定义启动器目录。更多安装细节见 [详细使用指南](./USAGE_ZH.md#安装细节)。

## 快速开始

运行安装后的命令：

```bash
memorycode
```

本地开发模式：

```bash
npm run dev
```

离线演示模式：

```bash
MEMORY_CODE_MODEL_MODE=mock npm run dev
```

## 常用入口

- `/help`：查看交互帮助。
- `/tools`：查看当前可用工具。
- `/memory`：查看本轮加载的指令文件与持久记忆健康报告。
- `/plan`：查看当前内存中的 Todo 清单。
- `/goal <目标>`、`/goal [status]`、`/goal pause [原因]`、`/goal resume`、`/goal clear`：创建、查看和控制 Goal。
- `/loop [Nm|Nh] <提示词>`、`/loop`、`/loop stop`：创建、查看和停止重复触发，默认 10 分钟，最短 1 分钟。
- `/skills`：查看当前可发现的 skills。
- `/mcp`：查看当前 MCP 连接状态。
- `/status`：查看会话和上下文状态。
- `/init`：为当前项目生成 `.memory-code/` 与 `MEMORY.md` 初始化文件。
- `/model` / `/model <name>`：查看或切换模型。
- `/resume`：打开会话选择器。
- `/compact`：手动压缩上下文。

管理命令包括 `memorycode mcp ...` 和 `memorycode skills ...`，详见 [命令说明](./USAGE_ZH.md#命令)。


## 开发

```bash
npm run check
npm test
```

MemoryCode 有意保持小而实用。目标是让整体架构足够清晰、易改造、易扩展——尤其是记忆管线。

## 致谢

MemoryCode 基于开源项目 [MiniCode](https://github.com/LiuMengxuan04/MiniCode) 构建，这是由 [Liu Mengxuan](https://github.com/LiuMengxuan04) 发起、社区共同贡献的轻量级类 Claude Code 编码助手（长会话上下文系统、长程规划工作流、分层 memory 基础等均来自上游）。本仓库在其基础上新增的核心内容是知识图谱记忆、事实生命周期与技能生命周期。感谢所有上游作者。
