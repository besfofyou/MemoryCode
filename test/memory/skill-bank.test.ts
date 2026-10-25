import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SkillBank } from '../../src/memory/skill-bank.js'
import type { Skill } from '../../src/memory/types.js'

function makeSkill(id: string, principle: string, title = principle.slice(0, 20)): Skill {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    skill_id: id,
    title,
    principle,
    when_to_apply: '',
    tags: [],
    usage_count: 0,
    success_count: 0,
    lifecycle: 'active',
    parent_id: null,
    generation: 0,
    children: [],
    recent_failures: [],
    createdAt: now,
    updatedAt: now,
  }
}

// 以下原则文本取自生产数据 .mini-code/memory/skill-bank.json：
// 旧的 token 重叠检测（阈值 0.6、无拉丁通道）没能拦下这些换措辞的重复提取
const RUN_TESTS_A = '改动或分析 MiniCode-main 后，验证测试通过 test/run-tests.mjs 聚合执行（测试文件本身是 node:test 风格的 .ts）；代码风格检查由 eslint.config.js 约束。'
const RUN_TESTS_B = '测试位于 test/ 下的 .ts 文件（node:test 风格），由 run-tests.mjs 聚合执行；改动后应运行该聚合脚本做验证。'
const AGENT_LOOP_A = '分析或修改 MiniCode 的 agent 行为时，从 src/agent-loop.ts 的 runAgentTurnWithOutcome 入手：核对每 step 的上下文收敛顺序（snip→micro→collapse→必要时 autoCompact）、model.next 调用与 assistant/progress/tool_calls 三路分支，以及 maxSteps/abort/重试等退出条件；优先改循环层而非 TUI 层。'
const AGENT_LOOP_B = '分析该项目 agent loop 或修改主循环时，入口定位到 src/agent-loop.ts 的 runAgentTurnWithOutcome，按“上下文收敛 → model.next → 分支处理（final / progress / tool_calls）”三段结构阅读，避免在多处重复追踪。'

describe('SkillBank.findNearDuplicate', () => {
  it('catches paraphrased duplicates that share commands and paths (latin channel)', () => {
    const bank = new SkillBank('unused.json')
    bank.add(makeSkill('distill_e486c88d', RUN_TESTS_A))
    assert.ok(bank.findNearDuplicate(RUN_TESTS_B), 'run-tests.mjs 重述应命中拉丁通道')

    const loopBank = new SkillBank('unused.json')
    loopBank.add(makeSkill('distill_f9ae0147', AGENT_LOOP_A))
    assert.ok(loopBank.findNearDuplicate(AGENT_LOOP_B), 'agent-loop.ts 重述应命中拉丁通道')
  })

  it('catches short restatements that merely repeat the same command', () => {
    const bank = new SkillBank('unused.json')
    bank.add(makeSkill('distill_e486c88d', RUN_TESTS_A))
    assert.ok(bank.findNearDuplicate('改动后运行 run-tests.mjs 做验证。'))
  })

  it('still catches near-identical text via full token overlap', () => {
    const bank = new SkillBank('unused.json')
    bank.add(makeSkill('s1', '分析陌生仓库时先统计 src/ 与 test/ 的文件数与行数，再读 package.json 确认技术栈与入口。'))
    assert.ok(bank.findNearDuplicate('分析陌生仓库时先统计 src/ 与 test/ 的文件数与行数，再读 package.json 确认技术栈与入口（补充说明）。'))
  })

  it('does not flag distinct skills that merely share a couple of tokens', () => {
    const bank = new SkillBank('unused.json')
    bank.add(makeSkill('distill_e486c88d', RUN_TESTS_A))
    bank.add(makeSkill('distill_f9ae0147', AGENT_LOOP_A))

    // 结构重构建议 vs 测试/循环知识：只共享 src、ts 等零散 token，不是重复
    assert.equal(bank.findNearDuplicate('结构整改按收益/风险比排序：先拆 src/tty-app.ts 降低耦合，再拆 src/mcp.ts 并解开循环依赖。'), null)
    // 部署流程 vs 验证流程：只共享 npm、run 等通用 token，不是重复
    assert.equal(bank.findNearDuplicate('部署前先执行 npm run build 打包产物，再通过 scp 上传到服务器。'), null)
    // 与命令/路径完全无关的技能不应误伤
    assert.equal(bank.findNearDuplicate('回答保持精简，只给结论与关键点，避免长篇大论。'), null)
  })
})
