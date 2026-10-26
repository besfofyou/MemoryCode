import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ForgeEngine, type EvolutionConfig } from '../../src/memory/skill-evolution.js'
import { SkillBank, MAX_RETIRED_SKILLS } from '../../src/memory/skill-bank.js'
import type { Skill } from '../../src/memory/types.js'

function makeSkill(overrides: Partial<Skill> & { skill_id: string }): Skill {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    title: `skill ${overrides.skill_id}`,
    principle: `principle for ${overrides.skill_id}: run tests before committing`,
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
    ...overrides,
  }
}

/** add() 强制新技能从 trial 进入（出生路径不变量）；测试种子需要已确立的状态时补回 */
function seed(bank: SkillBank, skill: Skill, category = 'general'): void {
  const lifecycle = skill.lifecycle
  bank.add(skill, category)
  skill.lifecycle = lifecycle
}

/** 阈值全部缩小，让少量 usage 就能触发各转换 */
const TEST_CONFIG: EvolutionConfig = {
  fitnessWarmup: 2,
  defaultFitness: 0.5,
  retireFitnessThreshold: 0.4,
  demoteFitnessThreshold: 0.6,
  stabilizeFitnessThreshold: 0.7,
  promoteMinUsage: 4,
  retireMinUsage: 6,
  stabilizeMinUsage: 8,
  mutateFitnessLow: 0.3,
  mutateFitnessHigh: 0.6,
  mutateMinUsage: 4,
  maxMutationsPerCycle: 2,
  maxRetirementsPerCycle: 3,
  maxTotalSkills: 50,
  evolveEveryNTurns: 1,
  originalSkillProtectionUsage: 20,
}

async function withEnv(
  fn: (bank: SkillBank, engine: ForgeEngine, dir: string) => Promise<void>,
  config: Partial<EvolutionConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'minicode-forge-'))
  try {
    const bank = new SkillBank(path.join(dir, 'skill-bank.json'))
    const engine = new ForgeEngine({ ...TEST_CONFIG, ...config }, dir)
    await fn(bank, engine, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('ForgeEngine lifecycle state machine', () => {
  it('only evolves every N turns and returns null otherwise', async () => {
    await withEnv(async (bank, engine) => {
      bank.add(makeSkill({ skill_id: 's1' }))
      assert.equal(await engine.maybeEvolve(bank), null)
      assert.equal(await engine.maybeEvolve(bank), null)
      const summary = await engine.maybeEvolve(bank)
      assert.ok(summary, 'third call (evolveEveryNTurns=3) triggers a cycle')
      assert.equal(summary!.validation_count, 3)
    }, { evolveEveryNTurns: 3 })
  })

  it('promotes trial skills with acceptable fitness to active and bumps updatedAt', async () => {
    await withEnv(async (bank, engine) => {
      const s = makeSkill({ skill_id: 's1', usage_count: 4, success_count: 3 }) // fitness 0.75
      bank.add(s)
      const summary = await engine.maybeEvolve(bank)
      assert.deepEqual(summary!.promoted, ['s1'])
      assert.equal(bank.getSkill('s1')!.lifecycle, 'active')
      assert.ok(bank.getSkill('s1')!.updatedAt > '2026-01-01')
    })
  })

  it('retires failing trials directly (trial → retired) instead of promoting them', async () => {
    await withEnv(async (bank, engine) => {
      const s = makeSkill({ skill_id: 'bad', usage_count: 4, success_count: 1 }) // fitness 0.25
      bank.add(s)
      const summary = await engine.maybeEvolve(bank)
      assert.deepEqual(summary!.promoted, [])
      assert.equal(summary!.retired.length, 1)
      assert.equal(summary!.retired[0]!.skill_id, 'bad')
      assert.equal(summary!.retired[0]!.reason, 'trial')

      // 软淘汰：记录保留（去重可用），但不再占据检索与容量
      const retired = bank.getSkill('bad')
      assert.equal(retired!.lifecycle, 'retired')
      assert.equal(bank.size, 0)
      const retrieved = bank.retrieve('run tests before committing')
      assert.equal(retrieved.general.some(x => x.skill_id === 'bad'), false)
    })
  })

  it('soft-retired tombstones still block re-learning via findNearDuplicate', async () => {
    await withEnv(async (bank, engine) => {
      bank.add(makeSkill({ skill_id: 'bad', usage_count: 4, success_count: 1 }))
      await engine.maybeEvolve(bank)
      // 蒸馏器重新提取同一条技能时应命中墓碑，而不是再次入库
      assert.ok(bank.findNearDuplicate('principle for bad: run tests before committing'))
      assert.equal(bank.getSkill('bad')!.lifecycle, 'retired')
    })
  })

  it('demotes stable skills whose fitness dropped', async () => {
    await withEnv(async (bank, engine) => {
      seed(bank, makeSkill({ skill_id: 's1', lifecycle: 'stable', usage_count: 10, success_count: 5 })) // 0.5 < 0.6
      const summary = await engine.maybeEvolve(bank)
      assert.deepEqual(summary!.demoted, ['s1'])
      assert.equal(bank.getSkill('s1')!.lifecycle, 'active')
    })
  })

  it('stabilizes active skills with high fitness and enough usage', async () => {
    await withEnv(async (bank, engine) => {
      seed(bank, makeSkill({ skill_id: 's1', lifecycle: 'active', usage_count: 10, success_count: 9 })) // 0.9
      const summary = await engine.maybeEvolve(bank)
      assert.deepEqual(summary!.stabilized, ['s1'])
      assert.equal(bank.getSkill('s1')!.lifecycle, 'stable')
    })
  })

  it('protects original (generation 0) skills from early fitness retirement', async () => {
    await withEnv(async (bank, engine) => {
      seed(bank, makeSkill({ skill_id: 'orig', lifecycle: 'active', usage_count: 10, success_count: 1, generation: 0 }))
      seed(bank, makeSkill({ skill_id: 'mut', lifecycle: 'active', usage_count: 10, success_count: 1, generation: 1 }))
      const summary = await engine.maybeEvolve(bank)
      // usage 10 >= retireMinUsage(6) 但 < originalSkillProtectionUsage(20)：原始技能保留，变异后代淘汰
      assert.equal(bank.getSkill('orig')!.lifecycle, 'active')
      assert.equal(bank.getSkill('mut')!.lifecycle, 'retired')
      assert.equal(summary!.retired[0]!.reason, 'fitness')
    })
  })

  it('mutates mid-fitness actives: child is trial, inherits lineage and parent category', async () => {
    await withEnv(async (bank, engine) => {
      const parent = makeSkill({
        skill_id: 'p1', lifecycle: 'active',
        usage_count: 10, success_count: 5, generation: 1, // fitness 0.5
      })
      seed(bank, parent, 'testing')
      const mutateFn = async (p: Skill): Promise<Skill> =>
        makeSkill({ skill_id: 'child1', principle: `improved: ${p.principle}` })

      const summary = await engine.maybeEvolve(bank, mutateFn)
      assert.equal(summary!.mutated.length, 1)
      assert.equal(summary!.mutated[0]!.parent_id, 'p1')

      const child = bank.getSkill('child1')!
      assert.equal(child.lifecycle, 'trial')
      assert.equal(child.parent_id, 'p1')
      assert.equal(child.generation, 2)
      assert.deepEqual(bank.getSkill('p1')!.children, ['child1'])
      // 变异子技能留在父技能的任务分组，而不是落入 general
      assert.equal(bank.categoryOf('child1'), 'testing')
      assert.ok(bank.data.task_specific_skills['testing']!.some(s => s.skill_id === 'child1'))
    })
  })

  it('merges near-duplicate trials before promotion so recurring skills can cross the usage bar', async () => {
    await withEnv(async (bank, engine) => {
      // 生产样本：蒸馏器换措辞把同一经验学了两遍，usage 被分流（各 2 次，谁也到不了 4）
      const a = makeSkill({
        skill_id: 'a1',
        title: '改动后运行 test/run-tests.mjs 聚合执行全部测试用例做验证',
        principle: '改动或分析 MiniCode-main 后，验证测试通过 test/run-tests.mjs 聚合执行（测试文件本身是 node:test 风格的 .ts）；代码风格检查由 eslint.config.js 约束。',
        usage_count: 2, success_count: 2,
      })
      const b = makeSkill({
        skill_id: 'b2',
        title: '测试位于 test/ 下，由 run-tests.mjs 聚合执行',
        principle: '测试位于 test/ 下的 .ts 文件（node:test 风格），由 run-tests.mjs 聚合执行；改动后应运行该聚合脚本做验证。',
        usage_count: 2, success_count: 2,
      })
      bank.add(a)
      bank.add(b)

      const summary = await engine.maybeEvolve(bank)
      const mergedEntry = summary!.retired.find(r => r.reason === 'merged')
      assert.ok(mergedEntry, '重复对应在晋升前先合并（败者转为墓碑）')
      const winnerId = mergedEntry!.skill_id === 'a1' ? 'b2' : 'a1'
      const winner = bank.getSkill(winnerId)!
      assert.equal(winner.usage_count, 4, '败者的 usage 应并入胜者')
      assert.equal(winner.lifecycle, 'active', '合并后 usage 越过 promoteMinUsage，同周期晋升')
      assert.deepEqual(summary!.promoted, [winnerId])
      // 败者墓碑仍拦截蒸馏器重学
      assert.ok(bank.findNearDuplicate('改动后运行 test/run-tests.mjs 聚合执行全部测试用例做验证'))
    })
  })

  it('enforces the capacity cap by retiring the least-fit live skill', async () => {
    await withEnv(async (bank, engine) => {
      for (let i = 0; i < 5; i++) {
        seed(bank, makeSkill({ skill_id: `good${i}`, lifecycle: 'active', usage_count: 10, success_count: 9 }))
      }
      seed(bank, makeSkill({ skill_id: 'worst', lifecycle: 'active', usage_count: 10, success_count: 5, generation: 1 }))
      const summary = await engine.maybeEvolve(bank)
      assert.ok(bank.size <= 5)
      assert.equal(bank.getSkill('worst')!.lifecycle, 'retired')
      const capacityEntry = summary!.retired.find(r => r.reason === 'capacity')
      assert.equal(capacityEntry?.skill_id, 'worst')
    }, { maxTotalSkills: 5 })
  })

  it('fitness() uses the default during warmup and the real ratio afterwards', async () => {
    await withEnv(async (_bank, engine) => {
      assert.equal(engine.fitness(makeSkill({ skill_id: 'w', usage_count: 1, success_count: 0 })), 0.5)
      assert.equal(engine.fitness(makeSkill({ skill_id: 'w', usage_count: 4, success_count: 1 })), 0.25)
    })
  })

  it('exposes the configured capacity for callers computing headroom', async () => {
    await withEnv(async (_bank, engine) => {
      assert.equal(engine.capacity, 50)
    })
  })
})

describe('SkillBank retire / lineage hygiene', () => {
  it('retire() marks retired, rejects unknown ids and is idempotent', async () => {
    await withEnv(async bank => {
      bank.add(makeSkill({ skill_id: 's1', lifecycle: 'active' }))
      assert.equal(bank.retire('nope'), false)
      assert.equal(bank.retire('s1'), true)
      assert.equal(bank.retire('s1'), false)
      assert.equal(bank.getSkill('s1')!.lifecycle, 'retired')
      assert.deepEqual(bank.counts(), { general: 0, taskSpecific: 0, retired: 1, total: 0 })
    })
  })

  it('prunes the oldest retired tombstones beyond MAX_RETIRED_SKILLS', async () => {
    await withEnv(async bank => {
      const retired = Array.from({ length: MAX_RETIRED_SKILLS + 5 }, (_, i) =>
        makeSkill({ skill_id: `r${i}`, lifecycle: 'retired' }))
      bank.data.general_skills = [...retired, makeSkill({ skill_id: 'live', lifecycle: 'active' })]
      bank.retire('live')

      const remaining = bank.allSkills(true).filter(s => s.lifecycle === 'retired')
      assert.equal(remaining.length, MAX_RETIRED_SKILLS)
      // 最旧的墓碑被丢弃，刚淘汰的保留
      assert.equal(bank.getSkill('r0'), null)
      assert.equal(bank.getSkill('live')!.lifecycle, 'retired')
    })
  })

  it('remove() detaches the skill from its lineage (no dangling parent/children refs)', async () => {
    await withEnv(async bank => {
      const grand = makeSkill({ skill_id: 'g1' })
      grand.children = ['p1']
      const parent = makeSkill({ skill_id: 'p1', parent_id: 'g1' })
      parent.children = ['c1']
      const child = makeSkill({ skill_id: 'c1', parent_id: 'p1' })
      bank.add(grand)
      bank.add(parent)
      bank.add(child)

      bank.remove('p1')
      assert.equal(bank.getSkill('p1'), null)
      assert.deepEqual(bank.getSkill('g1')!.children, [], '父技能的 children 不应残留已删除的 ID')
      assert.equal(bank.getSkill('c1')!.parent_id, null, '子技能的 parent_id 不应悬空')
    })
  })

  it('categoryOf() resolves general, task-specific and unknown ids', async () => {
    await withEnv(async bank => {
      bank.add(makeSkill({ skill_id: 'g1' }), 'general')
      bank.add(makeSkill({ skill_id: 't1' }), 'testing')
      assert.equal(bank.categoryOf('g1'), 'general')
      assert.equal(bank.categoryOf('t1'), 'testing')
      assert.equal(bank.categoryOf('missing'), 'general')
    })
  })
})
