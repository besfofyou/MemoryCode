import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModelAdapter, AgentStep, ChatMessage, ModelRequestOptions } from '../../src/types.js'
import { MemoryFilesystem } from '../../src/memory/filesystem.js'
import { distillSessionEnd, extractTitle } from '../../src/memory/distiller.js'
import { SkillBank } from '../../src/memory/skill-bank.js'

class FixedModel implements ModelAdapter {
  constructor(private readonly response: AgentStep) {}
  async next(_messages: ChatMessage[], _options?: ModelRequestOptions): Promise<AgentStep> {
    return this.response
  }
}

describe('extractTitle', () => {
  it('does not truncate titles at dots inside file paths (production regression)', () => {
    // 生产样本 .mini-code/memory/skill-bank.json：旧逻辑 split(/[。.!？\n]/) 把标题切在路径的点上。
    // 这三句首句都超过 80 字符会被截断补 …，因此断言「路径完整保留」而非全等。
    const title1 = extractTitle('分析陌生仓库结构的推荐流程：先统计 src/ 与 test/ 的文件数与行数了解规模，再读 package.json/tsconfig 确认技术栈与入口（bin/），然后按分层归类 src/。后续再展开。')
    assert.ok(title1.startsWith('分析陌生仓库结构的推荐流程：先统计 src/ 与 test/ 的文件数与行数了解规模，再读 package.json/tsconfig'), `got: ${title1}`)
    assert.ok(title1.endsWith('…'))

    const title2 = extractTitle('分析或修改 MiniCode 的 agent 行为时，从 src/agent-loop.ts 的 runAgentTurnWithOutcome 入手：核对上下文收敛顺序与 model.next 调用。再看退出条件。')
    assert.ok(title2.includes('src/agent-loop.ts'), `got: ${title2}`)
    assert.ok(title2.startsWith('分析或修改 MiniCode 的 agent 行为时'), `got: ${title2}`)

    const title3 = extractTitle('该项目类型检查用 npm run check（tsc），但 tsconfig include 仅覆盖 src/**/*.ts；要校验测试需把 include 扩为 test。当前有 38 个测试。')
    assert.ok(title3.includes('npm run check'), `got: ${title3}`)
    assert.ok(title3.includes('src/**/*.ts'), `got: ${title3}`)
  })

  it('protects dotted chains, bare extensions, dotfiles and decimals', () => {
    assert.equal(extractTitle('代码风格检查由 eslint.config.js 约束。其余略。'), '代码风格检查由 eslint.config.js 约束')
    assert.equal(extractTitle('测试位于 test/ 下的 .ts 文件，风格为 node:test。略。'), '测试位于 test/ 下的 .ts 文件，风格为 node:test')
    assert.equal(extractTitle('补 .gitignore 覆盖 .idea/ 与 .workbuddy/ 目录。略。'), '补 .gitignore 覆盖 .idea/ 与 .workbuddy/ 目录')
    assert.equal(extractTitle('该任务耗时约 1.5 小时完成。略。'), '该任务耗时约 1.5 小时完成')
    assert.equal(extractTitle('按 model.next 的调用顺序排查循环分支。略。'), '按 model.next 的调用顺序排查循环分支')
  })

  it('still splits on real sentence punctuation', () => {
    assert.equal(extractTitle('First sentence ends here. Second sentence follows'), 'First sentence ends here')
    assert.equal(extractTitle('中文句号结束。第二句'), '中文句号结束')
    assert.equal(extractTitle('换行结束\n第二行'), '换行结束')
  })

  it('appends ellipsis when the first sentence exceeds 80 chars and falls back to Untitled', () => {
    const long = '一'.repeat(90) + '。'
    const title = extractTitle(long)
    assert.ok(title.endsWith('…'))
    assert.equal(title.length, 81)
    assert.equal(extractTitle(''), 'Untitled')
    assert.equal(extractTitle('。。。'), 'Untitled')
  })
})

describe('distillSessionEnd (procedural + SkillBank only)', () => {
  it('stores validated skills only; secrets are dropped and facts stay with the CogMem extractor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-distiller-'))
    try {
      const store = new MemoryFilesystem(root)
      await store.ensureStructure()
      const model = new FixedModel({
        type: 'assistant',
        content: JSON.stringify({
          skills: [
            { content: 'Run npm test after changing memory modules to verify all cases.', tags: ['workflow'] },
            { content: 'api_key: abcdefghijklmnopqrstuvwxyz012345', tags: [] },
          ],
          summary: 'Implemented and tested the persistent memory integration.',
        }),
      })
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Please inspect the project settings.' },
        { role: 'assistant', content: 'The project uses strict TypeScript.' },
        { role: 'user', content: 'What else was accomplished?' },
      ]
      const skillBank = new SkillBank(path.join(root, 'skill-bank.json'))
      const result = await distillSessionEnd(messages, model, store, 'session', { skillBank })
      // api_key 样本被安全校验拒绝：procedural 不写入，SkillBank 侧 sanitizeSkill 返回 null 并记录原因
      assert.deepEqual(result, { skillsCount: 1, bankAdded: 1, reason: 'rejected by sanitizeSkill' })
      assert.equal((await store.listTier('procedural')).length, 1)
      assert.equal(skillBank.size, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies the documented minimum length (10 chars) for skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-distiller-boundaries-'))
    try {
      const store = new MemoryFilesystem(root)
      await store.ensureStructure()
      const model = new FixedModel({
        type: 'assistant',
        content: JSON.stringify({
          skills: [
            { content: 'x'.repeat(9) },
            { content: 'x'.repeat(10) },
          ],
          summary: '1234567890',
        }),
      })
      const messages: ChatMessage[] = [
        { role: 'user', content: 'First user turn.' },
        { role: 'assistant', content: 'Assistant response.' },
        { role: 'user', content: 'Second user turn.' },
      ]
      const skillBank = new SkillBank(path.join(root, 'skill-bank.json'))
      assert.deepEqual(await distillSessionEnd(messages, model, store, 'boundary', { skillBank }), {
        skillsCount: 1,
        bankAdded: 1,
      })
      assert.equal((await store.listTier('procedural')).length, 1)
      assert.equal(skillBank.size, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('derives bank titles without truncating file paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-distiller-title-'))
    try {
      const store = new MemoryFilesystem(root)
      await store.ensureStructure()
      const model = new FixedModel({
        type: 'assistant',
        content: JSON.stringify({
          skills: [{
            content: '改动或分析 MiniCode-main 后，验证测试通过 test/run-tests.mjs 聚合执行（测试文件本身是 node:test 风格的 .ts）。',
            when_to_apply: '在本仓库完成代码改动后',
            tags: ['workflow'],
          }],
          summary: '',
        }),
      })
      const messages: ChatMessage[] = [
        { role: 'user', content: 'How do we verify changes in this repo?' },
        { role: 'assistant', content: 'Run the aggregated test script.' },
        { role: 'user', content: 'Anything else to note?' },
      ]
      const skillBank = new SkillBank(path.join(root, 'skill-bank.json'))
      const result = await distillSessionEnd(messages, model, store, 'title', { skillBank })
      assert.deepEqual(result, { skillsCount: 1, bankAdded: 1 })
      const skill = skillBank.data.general_skills[0]!
      assert.equal(
        skill.title,
        '改动或分析 MiniCode-main 后，验证测试通过 test/run-tests.mjs 聚合执行（测试文件本身是 node:test 风格的 .ts）',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
