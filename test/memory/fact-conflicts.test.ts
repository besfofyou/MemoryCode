import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../../src/types.js'
import type { FactNode, PersonNode, EventNode } from '../../src/memory/types.js'
import { GraphStore } from '../../src/memory/graph-store.js'
import { VectorStore } from '../../src/memory/vector-store.js'
import { CogMemExtractor } from '../../src/memory/extractor.js'
import { MemoryConsolidator } from '../../src/memory/consolidator.js'
import { isRetrievable } from '../../src/memory/retrieval-policy.js'
import {
  canonicalPredicate, isStatefulPredicate, resolveWriteConflicts,
  backfillFactTemporal, annotateCurrentFacts, supersedeFact,
} from '../../src/memory/fact-conflicts.js'
import { detectUnbackedMemoryClaim } from '../../src/memory/runtime.js'
import { FixedModel, MockEmbeddingClient } from './cogmem-helpers.js'

const dayMs = 86_400_000
const today = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - dayMs).toISOString().slice(0, 10)

function extraction(json: unknown) { return JSON.stringify(json) }

/** 最小对话：内容需超过 chunkMessages 的 50 字符下限，行前缀为 "[user]:" / "[assistant]:" */
function conv(userText: string, assistantText = '好的，我明白了。还有别的需要我处理的，随时说。'): ChatMessage[] {
  return [
    { role: 'user', content: `${userText}。这件事对我来说挺重要的，麻烦认真记一下。` },
    { role: 'assistant', content: assistantText },
  ]
}

const PERSONS = [{ name: 'User' }]

describe('P0-1 时间双轴：谓词归一与单值判定', () => {
  it('canonicalPredicate folds synonym predicates to one form', () => {
    assert.equal(canonicalPredicate('lives_in'), 'lives_in')
    assert.equal(canonicalPredicate('resides_in'), 'lives_in')
    assert.equal(canonicalPredicate('moved_residence'), 'lives_in')
    assert.equal(canonicalPredicate('is_living_in'), 'lives_in')
    assert.equal(canonicalPredicate('works_for'), 'works_at')
    assert.equal(canonicalPredicate('attended'), 'attended')
  })

  it('isStatefulPredicate: residence/employer are stateful; attendance is not', () => {
    assert.equal(isStatefulPredicate('lives_in'), true)
    assert.equal(isStatefulPredicate('resides_in'), true)
    assert.equal(isStatefulPredicate('uses_test_framework'), true)
    assert.equal(isStatefulPredicate('attended'), false)
    assert.equal(isStatefulPredicate('uses'), false)            // 裸 uses 可多值（TypeScript 与 Node 并存）
    assert.equal(isStatefulPredicate('contains'), false)
  })
})

describe('P0-1 时间双轴：写入时冲突消解（不依赖事后 reconcile）', () => {
  it('浦东→徐汇：后陈述立即归档旧事实，即使其生效时间更早', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())

    // 会话 A：用户说"我现在住在浦东"（现在时 → effective_from = 当天）
    const exA = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: '浦东', description: '上海浦东' }],
      events: [],
      facts: [{ subject: 'User', predicate: 'lives_in', object: '浦东', source: 'user', effective_from: null, evidence: '我现在住在浦东' }],
      claims: [], invalidations: [],
    })]))
    await exA.extractFromMessages(conv('我现在住在浦东', '已记下：你目前住在浦东。'), 'session-a')

    // 会话 B：用户说"我上个月搬到徐汇了"（换了谓词措辞 resides_in，生效时间是上个月=更早）
    const exB = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: '徐汇', description: '上海徐汇' }],
      events: [],
      facts: [{ subject: 'User', predicate: 'resides_in', object: '徐汇', source: 'user', effective_from: yesterday, evidence: '我上个月搬到徐汇' }],
      claims: [], invalidations: [],
    })]))
    await exB.extractFromMessages(conv('我上个月搬到徐汇了', '已记下：你目前住在徐汇。'), 'session-b')

    const facts = graph.getNodesByType<FactNode>('fact')
    assert.equal(facts.length, 2)
    const pudong = facts.find(f => f.object === '浦东')!
    const xuhui = facts.find(f => f.object === '徐汇')!

    // 徐汇（陈述更晚）是现行值；浦东立即归档并挂 SUPERSEDES 链
    assert.equal(xuhui.is_latest, true)
    assert.notEqual(xuhui.lifecycle, 'archived')
    assert.equal(pudong.lifecycle, 'archived')
    assert.equal(pudong.is_latest, false)
    assert.equal(pudong.superseded_by, xuhui.node_id)
    assert.equal(pudong.supersede_reason, 'stated_at_order')
    assert.ok(graph.getOutEdges(xuhui.node_id, 'SUPERSEDES').some(e => e.target_id === pudong.node_id))
    // 陈述时间序：徐汇 ≥ 浦东（按会话顺序）；生效时间相反（上个月 < 当天）——裁决只看陈述时间
    assert.ok(xuhui.stated_at! >= pudong.stated_at!)
    assert.equal(xuhui.effective_from, yesterday)
    assert.equal(pudong.valid_to, xuhui.effective_from)
    // 归档事实移出向量索引、不再可检索
    assert.equal(vectors.getVector(pudong.node_id), undefined)
    assert.equal(isRetrievable(pudong), false)
    assert.equal(isRetrievable(xuhui), true)
  })

  it('多值谓词不误伤：attended 两条并存', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const mk = (obj: string, session: string) => new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: obj, description: `会议 ${obj}` }],
      events: [],
      facts: [{ subject: 'User', predicate: 'attended', object: obj, source: 'user', evidence: `参加了${obj}` }],
      claims: [], invalidations: [],
    })]))
    await mk('产品评审会', 's1').extractFromMessages(conv(`我参加了产品评审会`, '记下了'), 's1')
    await mk('发布会', 's2').extractFromMessages(conv(`我参加了发布会`, '记下了'), 's2')

    const facts = graph.getNodesByType<FactNode>('fact')
    assert.equal(facts.length, 2)
    for (const f of facts) {
      assert.notEqual(f.lifecycle, 'archived')
      assert.notEqual(f.is_latest, false)
    }
  })

  it('旧数据迁移 backfillFactTemporal：回填双时间轴并消解遗留冲突', () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const mk = (id: string, pred: string, obj: string, createdAt: string): FactNode => ({
      node_id: id, node_type: 'fact', subject: 'User', predicate: pred, object: obj,
      description: `User ${pred} ${obj}`, subject_id: 'p_u', object_id: `c_${obj}`,
      confidence: 0.6, lifecycle: 'candidate', is_latest: true, valid_from: createdAt.slice(0, 10),
      supported_by_event_ids: [], created_at: createdAt, updated_at: createdAt,
      source_session_id: 's', embedding_text: `Fact: ${pred} ${obj}`,
    })
    const pudong = mk('fact_pudong', 'lives_in', '浦东', '2026-10-25T10:00:00.000Z')
    const xuhui = mk('fact_xuhui', 'resides_in', '徐汇', '2026-10-25T11:00:00.000Z')
    graph.addNode(pudong); graph.addNode(xuhui)

    const r = backfillFactTemporal(graph, vectors)
    assert.equal(r.backfilled, 2)
    assert.equal(pudong.stated_at, '2026-10-25T10:00:00.000Z')
    assert.equal(xuhui.effective_from, '2026-10-25')          // 回退链 valid_from → created_at
    assert.equal(r.superseded, 1)
    assert.equal(pudong.lifecycle, 'archived')                 // created_at 更晚的徐汇胜出
    assert.equal(xuhui.is_latest, true)
  })
})

describe('P0-2 防回写：assistant 推理不落成事实', () => {
  it('source=assistant 的事实被跳过', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const extractor = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: '浦东', description: '居住地' }],
      events: [],
      facts: [{ subject: 'User', predicate: 'lives_in', object: '浦东', source: 'assistant', evidence: '你现在住浦东' }],
      claims: [], invalidations: [],
    })]))
    const messages: ChatMessage[] = [
      { role: 'user', content: '我现在住哪个区？我以前住哪？这个问题我想听你仔细分析一下。' },
      { role: 'assistant', content: '根据记忆中的记录：你现在住浦东，这是最新一条；以前住徐汇。' },
    ]
    await extractor.extractFromMessages(messages, 's')
    assert.equal(graph.getNodesByType<FactNode>('fact').length, 0)
  })

  it('证据落在 assistant 发言行上的"事实"被确定性跳过（即使 LLM 声称 user）', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const extractor = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: '徐汇', description: '以前住过' }],
      events: [],
      facts: [{ subject: 'User', predicate: 'previously_lived_in', object: '徐汇', source: 'user', evidence: '以前：徐汇' }],
      claims: [], invalidations: [],
    })]))
    const messages: ChatMessage[] = [
      { role: 'user', content: '我现在住哪个区？我以前住哪？麻烦把时间线也帮我理一下。' },
      { role: 'assistant', content: '以前：徐汇（2026-09-25 你说上个月搬到徐汇了），这条是我按记录推出来的。' },
    ]
    await extractor.extractFromMessages(messages, 's')
    assert.equal(graph.getNodesByType<FactNode>('fact').length, 0)
  })

  it('assistant 来源的 claim 降权为 candidate + 低置信度', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const extractor = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: '居住地记录', description: '记录' }],
      events: [],
      facts: [],
      claims: [{ source: 'Assistant', target: '居住地记录', content: '9 月搬徐汇 10 月又说住浦东', evidence: '记录有点来回' }],
      invalidations: [],
    })]))
    const messages: ChatMessage[] = [
      { role: 'user', content: '我现在住哪个区？顺便说说你觉得我的记录质量怎么样。' },
      { role: 'assistant', content: '记录有点来回，9 月搬徐汇、10 月又说住浦东，建议理一下。' },
    ]
    await extractor.extractFromMessages(messages, 's')
    const claims = graph.getNodesByType('claim')
    assert.equal(claims.length, 1)
    assert.equal(claims[0].confidence, 0.4)
    assert.equal(claims[0].lifecycle, 'candidate')
  })

  it('巩固器跳过 Assistant 人称簇（助手行为约定进技能库，不进事实图谱）', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const now = new Date().toISOString()
    const assistant: PersonNode = {
      node_id: 'p_a', node_type: 'person', canonical_name: 'Assistant', aliases: [],
      description: 'Person: Assistant', created_at: now, updated_at: now,
      source_session_id: 's', embedding_text: 'Assistant',
    }
    graph.addNode(assistant)
    for (let i = 0; i < 3; i++) {
      const e: EventNode = {
        node_id: `ev_${i}`, node_type: 'event', title: `Assistant asked for todo content ${i}`,
        description: 'asked instead of inventing', participants: ['p_a'], concepts: [],
        archived: false, created_at: now, updated_at: now, source_session_id: 's', embedding_text: `Event ${i}`,
      }
      graph.addNode(e)
    }
    const consolidator = new MemoryConsolidator(graph, vectors, new FixedModel([
      extraction({ content: 'Assistant always asks for todo content', predicate: 'todo_convention', confidence: 0.9, valid_from: null }),
    ]))
    const r = await consolidator.consolidate()
    // Assistant 簇被过滤，LLM 不再被调用合成"助手行为事实"
    assert.equal(r.factsCreated, 0)
    assert.equal(graph.getNodesByType<FactNode>('fact').length, 0)
  })
})

describe('P0-1 明示作废（invalidation）立即归档', () => {
  it('"之前记录已作废" → 匹配的活跃事实当刻归档', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const exA = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: '浦东', description: '居住地' }],
      events: [],
      facts: [{ subject: 'User', predicate: 'lives_in', object: '浦东', source: 'user', evidence: '我现在住在浦东' }],
      claims: [], invalidations: [],
    })]))
    await exA.extractFromMessages(conv('我现在住在浦东', '已记下。'), 's1')

    const exB = new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [],
      events: [],
      facts: [],
      claims: [],
      invalidations: [{ subject: 'User', predicate: 'lives_in', object: '浦东', evidence: '之前记录里的住在浦东已作废' }],
    })]))
    await exB.extractFromMessages(conv('纠正一下，之前那条住浦东的记录作废', '好的，之前的浦东记录已作废。'), 's2')

    const pudong = graph.getNodesByType<FactNode>('fact').find(f => f.object === '浦东')!
    assert.equal(pudong.lifecycle, 'archived')
    assert.equal(pudong.is_latest, false)
    assert.equal(pudong.supersede_reason, 'user_invalidation')
    assert.equal(pudong.superseded_by, undefined)               // 明示作废无替代事实
  })

  it('归档事实被用户重新陈述 → 复活并按陈述时间重新裁决', async () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const mk = (obj: string, session: string) => new CogMemExtractor(graph, vectors, new FixedModel([extraction({
      persons: PERSONS,
      concepts: [{ name: obj, description: '居住地' }],
      events: [],
      facts: [{ subject: 'User', predicate: 'lives_in', object: obj, source: 'user', evidence: `住在${obj}` }],
      claims: [], invalidations: [],
    })]))
    await mk('浦东', 's1').extractFromMessages(conv('我现在住在浦东', 'ok'), 's1')
    await mk('徐汇', 's2').extractFromMessages(conv('我搬到徐汇了', 'ok'), 's2')     // 浦东被归档
    // 用户重新陈述浦东（真实的新陈述，非 assistant 转述）
    await mk('浦东', 's3').extractFromMessages(conv('我现在又住回浦东了', 'ok'), 's3')

    const pudong = graph.getNodesByType<FactNode>('fact').find(f => f.object === '浦东')!
    const xuhui = graph.getNodesByType<FactNode>('fact').find(f => f.object === '徐汇')!
    assert.equal(pudong.is_latest, true)                        // 复活
    assert.notEqual(pudong.lifecycle, 'archived')
    assert.equal(xuhui.lifecycle, 'archived')                   // 徐汇被更新的陈述推翻
    assert.equal(xuhui.superseded_by, pudong.node_id)
    assert.ok(vectors.getVector(pudong.node_id))                // 向量重建
  })
})

describe('P0-2 写入一致：空口承诺检测', () => {
  const claimTurn: ChatMessage[] = [
    { role: 'user', content: '我上个月搬到徐汇了' },
    { role: 'assistant', content: '好的，已记下：你目前住在徐汇。之前记录里的"住在浦东"已作废。' },
  ]

  it('声称已记录但没有 memory_write 调用 → 命中', () => {
    const hit = detectUnbackedMemoryClaim(claimTurn)
    assert.ok(hit)
    assert.match(hit, /已记/)
  })

  it('同轮有成功的 memory_write → 不命中', () => {
    const turn: ChatMessage[] = [
      { role: 'user', content: '我上个月搬到徐汇了' },
      { role: 'assistant_tool_call', toolUseId: 't1', toolName: 'memory_write', input: {} },
      { role: 'tool_result', toolUseId: 't1', toolName: 'memory_write', content: 'Memory written', isError: false },
      { role: 'assistant', content: '已记下：你目前住在徐汇。' },
    ]
    assert.equal(detectUnbackedMemoryClaim(turn), null)
  })

  it('memory_write 失败仍然算空口承诺', () => {
    const turn: ChatMessage[] = [
      { role: 'user', content: '记一下我住在徐汇' },
      { role: 'assistant_tool_call', toolUseId: 't1', toolName: 'memory_write', input: {} },
      { role: 'tool_result', toolUseId: 't1', toolName: 'memory_write', content: 'Rejected', isError: true },
      { role: 'assistant', content: '已记录。' },
    ]
    assert.ok(detectUnbackedMemoryClaim(turn))
  })

  it('与记忆无关的"已保存"不误报', () => {
    const turn: ChatMessage[] = [
      { role: 'user', content: '把修改写进文件' },
      { role: 'assistant', content: '文件已保存，修改完成。' },
    ]
    assert.equal(detectUnbackedMemoryClaim(turn), null)
  })

  it('只检查本轮（上一轮的承诺不重复追责）', () => {
    const turn: ChatMessage[] = [
      { role: 'user', content: '记一下' },
      { role: 'assistant', content: '已记录。' },
      { role: 'user', content: '现在帮我看看代码' },
      { role: 'assistant', content: '看完了，没问题。' },
    ]
    assert.equal(detectUnbackedMemoryClaim(turn), null)
  })
})

describe('检索侧：双时间轴与 current/older 标注', () => {
  it('annotateCurrentFacts：同键多条活跃事实标注最新陈述为 current', () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const mk = (id: string, pred: string, obj: string, stated: string): FactNode => ({
      node_id: id, node_type: 'fact', subject: 'User', predicate: pred, object: obj,
      description: `User ${pred} ${obj}`, subject_id: 'p_u', object_id: `c_${obj}`,
      confidence: 0.6, lifecycle: 'stable', is_latest: true, stated_at: stated,
      supported_by_event_ids: [], created_at: stated, updated_at: stated,
      source_session_id: 's', embedding_text: `Fact: ${pred} ${obj}`,
    })
    const pudong = mk('f1', 'lives_in', '浦东', '2026-10-25T10:00:00.000Z')
    const xuhui = mk('f2', 'resides_in', '徐汇', '2026-10-25T11:00:00.000Z')
    const other = mk('f3', 'attended', '评审会', '2026-10-25T09:00:00.000Z')
    graph.addNode(pudong); graph.addNode(xuhui); graph.addNode(other)

    const ann = annotateCurrentFacts([pudong, xuhui, other])
    assert.equal(ann.get('f2'), 'current')                     // 陈述更晚的徐汇
    assert.equal(ann.get('f1'), 'older')
    assert.equal(ann.has('f3'), false)                         // 多值谓词不标注
  })

  it('supersedeFact 建立 SUPERSEDES 边并从向量索引移除', () => {
    const graph = new GraphStore()
    const vectors = new VectorStore(new MockEmbeddingClient())
    const now = new Date().toISOString()
    const a: FactNode = {
      node_id: 'fa', node_type: 'fact', subject: 'User', predicate: 'lives_in', object: 'A',
      description: 'd', confidence: 0.6, lifecycle: 'candidate', is_latest: true,
      supported_by_event_ids: [], created_at: now, updated_at: now, source_session_id: 's',
      embedding_text: 'Fact: a', stated_at: '2026-10-25T10:00:00.000Z', effective_from: '2026-10-25',
    }
    const b: FactNode = { ...a, node_id: 'fb', object: 'B', stated_at: '2026-10-25T11:00:00.000Z' }
    graph.addNode(a); graph.addNode(b)
    supersedeFact(graph, vectors, a, { reason: 'stated_at_order', newer: b })
    assert.equal(a.lifecycle, 'archived')
    assert.equal(a.superseded_by, 'fb')
    assert.ok(graph.getOutEdges('fb', 'SUPERSEDES').some(e => e.target_id === 'fa'))
  })
})
