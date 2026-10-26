import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryRuntime } from '../../src/memory/runtime.js'
import { SKILL_BANK_CONFIG } from '../../src/memory/constants.js'
import type { Skill } from '../../src/memory/types.js'
import type { AgentStep, ChatMessage, ModelAdapter, ModelRequestOptions } from '../../src/types.js'

/** 记录每次蒸馏调用收到的对话内容（蒸馏把对话放在最后一条 user 消息里） */
class CapturingModel implements ModelAdapter {
  readonly calls: string[] = []
  async next(messages: ChatMessage[], _options?: ModelRequestOptions): Promise<AgentStep> {
    this.calls.push(typeof messages[messages.length - 1]?.content === 'string' ? messages[messages.length - 1]!.content as string : '')
    return { type: 'assistant', content: JSON.stringify({ skills: [], summary: '' }) }
  }
}

function makeTrial(id: string): Skill {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    skill_id: id,
    title: `skill ${id}`,
    principle: `principle for ${id}: a unique workflow about topic ${id} with enough distinct tokens`,
    when_to_apply: '',
    tags: [],
    usage_count: 0,
    success_count: 0,
    lifecycle: 'trial',
    parent_id: null,
    generation: 0,
    children: [],
    recent_failures: [],
    createdAt: now,
    updatedAt: now,
  }
}

const build = (turns: number): ChatMessage[] => {
  const messages: ChatMessage[] = []
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: 'user', content: `user turn ${i}` })
    messages.push({ role: 'assistant', content: `assistant turn ${i}` })
  }
  return messages
}

describe('incremental skill distillation gate', () => {
  it('skips distillation while the trial pool is saturated (lets existing trials accumulate usage)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-gate-saturated-'))
    process.env.MINI_CODE_SKILL_DISTILL_EVERY = '1'
    try {
      const runtime = await MemoryRuntime.create(root, path.join(root, 'memory'))
      const model = new CapturingModel()
      runtime.initModel(model)
      for (let i = 0; i < SKILL_BANK_CONFIG.distillMinTrialsForPause; i++) {
        runtime.skillBank.add(makeTrial(`t${i}`))
      }

      await runtime.completeTurn({ outcome: 'awaiting_user', messages: build(2) })
      assert.equal(model.calls.length, 0, 'trial 池饱和时不应再调用模型蒸馏')
      const pending = (runtime as unknown as { bgSkillDistill: Promise<unknown> | null }).bgSkillDistill
      assert.equal(pending, null)
    } finally {
      delete process.env.MINI_CODE_SKILL_DISTILL_EVERY
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips thin deltas without advancing the cursor, then distills once enough messages accumulate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-gate-thin-'))
    process.env.MINI_CODE_SKILL_DISTILL_EVERY = '1'
    try {
      const runtime = await MemoryRuntime.create(root, path.join(root, 'memory'))
      const model = new CapturingModel()
      runtime.initModel(model)

      // delta 只有 2 条消息（< distillMinDeltaMessages）→ 跳过且不推进游标
      await runtime.completeTurn({ outcome: 'awaiting_user', messages: build(1) })
      assert.equal(model.calls.length, 0)

      // 消息攒够后放行，且蒸馏拿到的是包含早期消息的完整 delta
      await runtime.completeTurn({ outcome: 'awaiting_user', messages: build(2) })
      await (runtime as unknown as { bgSkillDistill: Promise<unknown> | null }).bgSkillDistill
      assert.equal(model.calls.length, 1)
      assert.ok(model.calls[0]!.includes('user turn 1'), '跳过不应丢消息：游标未推进')
      assert.ok(model.calls[0]!.includes('user turn 2'))
    } finally {
      delete process.env.MINI_CODE_SKILL_DISTILL_EVERY
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still distills normally when the pool is small and the delta is thick enough', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-gate-open-'))
    process.env.MINI_CODE_SKILL_DISTILL_EVERY = '2'
    try {
      const runtime = await MemoryRuntime.create(root, path.join(root, 'memory'))
      const model = new CapturingModel()
      runtime.initModel(model)

      await runtime.completeTurn({ outcome: 'awaiting_user', messages: build(1) })
      await runtime.completeTurn({ outcome: 'awaiting_user', messages: build(2) })
      await (runtime as unknown as { bgSkillDistill: Promise<unknown> | null }).bgSkillDistill
      assert.equal(model.calls.length, 1)
    } finally {
      delete process.env.MINI_CODE_SKILL_DISTILL_EVERY
      await rm(root, { recursive: true, force: true })
    }
  })
})
