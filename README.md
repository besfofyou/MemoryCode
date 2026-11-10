# MemoryCode

<p align="center">
  <img src="./docs/logo.svg" alt="MemoryCode Logo" width="180" />
</p>

<h2 align="center">MemoryCode</h2>

<p align="center">
  <img src="https://img.shields.io/badge/Editor-MemoryCode-D97757?style=for-the-badge" alt="Editor: MemoryCode" />
  <img src="https://img.shields.io/badge/%23memorycode-Project-B85C3F?style=for-the-badge" alt="#memorycode" />
  <img src="https://img.shields.io/badge/%23long--term-Memory-F0EBE1?style=for-the-badge&labelColor=8B8B8B" alt="#long-term Memory" />
  <img src="https://img.shields.io/badge/%23knowledge--Graph-F0EBE1?style=for-the-badge&labelColor=8B8B8B" alt="#knowledge Graph" />
</p>

---

<p align="center">
  A lightweight terminal coding assistant with long-term memory. It remembers your project, your decisions, and your corrections — across sessions.
</p>

[简体中文](./README.zh-CN.md) | [Usage Guide](./USAGE.md) | [Architecture](./ARCHITECTURE.md) | [Contributing](./CONTRIBUTING.md) | [Roadmap](./ROADMAP.md) | [License](./LICENSE)

MemoryCode is a terminal coding assistant with built-in long-term memory.

It keeps a lightweight, Claude Code-like agent-loop architecture, and adds a knowledge-graph memory system: every session can leave behind facts, events, lessons, and skills that are retrieved automatically in later sessions. It is especially useful for daily development on long-lived projects, and for learning how a memory-first agent is built.

## Overview

MemoryCode runs two loops side by side:

**The agent loop** (terminal-first, one turn at a time):

- accept a user request
- inspect the workspace
- call tools when needed
- review file changes before writing
- return a final response in the same terminal session

**The memory loop** (running underneath, across sessions):

- retrieve relevant memories before the model answers
- record what actually happened after each turn
- extract facts, events, and claims into a knowledge graph
- reconcile new facts against old ones (merge, supersede, or archive)
- consolidate sessions and distill reusable skills

The project is intentionally compact, so the control flow, tool model, memory pipeline, and TUI behavior remain easy to understand and extend.

## Why MemoryCode

MemoryCode is a good fit if you want:

- an assistant that remembers your stack, conventions, and corrections between sessions — not a conversation that resets to zero every time
- memory with a real lifecycle: facts are versioned, conflicts are resolved by statement time, and outdated records are archived instead of silently coexisting
- skills that grow out of your actual successes and failures, with usage-based fitness and retirement
- a lightweight coding assistant instead of a large platform
- a small codebase that is suitable for study and modification

## Core Capabilities

### Long-term memory

- A CogMem-inspired knowledge graph: `Person`, `Event`, `Concept`, `Claim`, and `Fact` nodes connected by typed edges (`SUPERSEDED_BY`, `SUPPORTED_BY`, `PARTICIPATED_IN`, ...), with up to 3 verbatim evidence quotes kept per item.
- Automatic per-turn retrieval: relevant memories are looked up and injected into the context before the model answers; `/memory` shows what was loaded plus a persistent-memory health report.
- Fact lifecycle on a temporal dual axis: `stated_at` (when the user last stated it — the only key for new/old arbitration) vs `effective_from` (when it became true in the world — for display and traceback only). Newer statements supersede older ones through explicit `SUPERSEDES` chains; archived facts leave the vector index.
- Conflict reconciliation: near-duplicate facts are merged (similarity ≥ 0.95), same-subject updates become version chains (similarity ≥ 0.80), borderline conflicts are confirmed by an LLM, and predicates are canonicalized (`lives_in`/`resides_in`/`moved_home` → `lives_in`) so reworded updates still match.
- Explicit invalidation: when the user declares an earlier record void, the old fact is archived instead of silently coexisting with the new one.
- User-anchored facts: only user statements (or user-confirmed outcomes) become facts; assistant reasoning is never written back into memory. Extraction bans secrets, tokens, and absolute paths.
- Anti-hallucination guard: a reply that claims a memory was recorded/updated/invalidated without an actual successful `memory_write`/`memory_forget` call is flagged (`unbacked-memory-claim`).
- Three memory tiers — `episodic`, `semantic`, `procedural` — with durability grades (`durable` / `session` / `volatile`), backed by a local vector store and embeddings for semantic retrieval.
- Dedicated tools: `memory_read` (search graph memories), `memory_write` (store procedures), `memory_forget` (soft delete with reason).

### Skill lifecycle (SkillForge)

- Skills live in a persistent skill bank with lifecycle `trial → active → stable → retired`, tracked by usage and success counts.
- Retrieval mixes proven skills with reserved explore slots for trial skills.
- Periodic evolution: promote, demote, retire, and stabilize by fitness; repeated failures can be analyzed into new candidate skills (mutation).
- Incremental distillation with gating (bank capacity, trial-pool saturation) to keep the pool focused; retired tombstones are capped so the bank stays bounded.
- `common_mistakes` are collected alongside skills.

### Agent core

- Multi-step tool execution in a single turn, forming a `model -> tool -> model` loop.
- Up to 3 concurrent read-only sub-agents; the root agent owns all code changes and can wait for or close workers.
- An in-memory Todo plan shared across root-agent turns, updated with `update_plan` and viewed with `/plan`.
- A user-created in-memory Goal that continues across turns, with `/goal pause`, `/goal resume`, and explicit completion checks.
- One process-local Loop repeats a prompt with a fixed delay after each run, shares the Plan, and stays mutually exclusive with active Goals.
- Full-screen terminal UI with input history, transcript scrolling, slash command menu, and approval flows.
- Per-project session persistence with resume, rename, fork, and compact commands.
- Provider-usage-first context stats with tail estimates, auto-compact, context collapse, and snip compact.
- Built-in tools for files, search, editing, command execution, web fetch/search, and clarification prompts.
- Local skills discovered through `SKILL.md`, plus MCP tools/resources/prompts over stdio or remote HTTP.
- Review-before-write file edits with path and command permission checks.
- Oversized tool results are stored on disk and replaced in context with a short preview and file path.

Full command references, configuration examples, session details, and Skills/MCP usage have moved to the [Usage Guide](./USAGE.md).

## Installation

```bash
git clone https://github.com/besfofyou/MemoryCode.git
cd MemoryCode
npm install
npm run install-local
```

The installer asks for the model name, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN`. Configuration is stored in:

- `~/.memory-code/settings.json`
- `~/.memory-code/mcp.json`

You can override the config directory with `MEMORY_CODE_HOME` and the launcher directory with `MEMORY_CODE_BIN_DIR`. See [Installation Details](./USAGE.md#installation-details) for more.

## Quick Start

Run the installed launcher:

```bash
memorycode
```

Run in development mode:

```bash
npm run dev
```

Run in offline demo mode:

```bash
MEMORY_CODE_MODEL_MODE=mock npm run dev
```

## Common Entry Points

- `/help`: show interactive help.
- `/tools`: list available tools.
- `/memory`: show the instruction files and persistent-memory health loaded for the current turn.
- `/plan`: view the current in-memory Todo list.
- `/goal <description>`, `/goal [status]`, `/goal pause [reason]`, `/goal resume`, `/goal clear`: create, inspect and control a Goal.
- `/loop [Nm|Nh] <prompt>`, `/loop`, `/loop stop`: create, inspect and stop a recurring prompt (default 10m; minimum 1m).
- `/skills`: list discovered skills.
- `/mcp`: show MCP connection status.
- `/status`: show session and context status.
- `/init`: scaffold `.memory-code/` and `MEMORY.md` for the current project.
- `/model` / `/model <name>`: inspect or switch the model.
- `/resume`: open the session picker.
- `/compact`: manually compact the context.

Management commands include `memorycode mcp ...` and `memorycode skills ...`. See [Commands](./USAGE.md#commands) for the full reference.



## Development

```bash
npm run check
npm test
```

MemoryCode is intentionally small and pragmatic. The goal is to keep the architecture understandable, hackable, and easy to extend — especially the memory pipeline.

## Acknowledgments

MemoryCode is built on top of [MiniCode](https://github.com/LiuMengxuan04/MiniCode), a lightweight Claude Code-like coding assistant created by [Liu Mengxuan](https://github.com/LiuMengxuan04) with contributions from the community (long-session context system, planning workflows, layered memory groundwork, and more). The knowledge-graph memory, fact lifecycle, and skill lifecycle in this repository are the main additions of this fork. Thanks to all upstream authors.
