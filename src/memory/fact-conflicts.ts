import type { AnyGraphNode, FactNode } from './types.js'
import type { GraphStore } from './graph-store.js'
import type { VectorStore } from './vector-store.js'

/**
 * P0 时间双轴 — 事实冲突的确定性裁决
 *
 * 双时间轴：
 *   stated_at       陈述时间：用户在哪次发言里说了这件事（会话顺序）。冲突裁决的唯一依据。
 *   effective_from  生效时间：这件事在世界里何时开始为真（如"上个月搬到徐汇"的搬家日期）。
 *                   仅用于展示/追溯，绝不参与新旧裁决——生效时间早不代表信息旧。
 *
 * 裁决规则：同一 subject + 规范化谓词（单值状态属性）出现第二条活跃事实时，写入当刻
 * 立即按 stated_at 归档较旧的一条。不依赖事后 reconcile，也不依赖 LLM 确认。
 */

/** 谓词同义折叠：lives_in / resides_in / moved_home 等归一到同一规范形，否则冲突匹配会漏 */
const PREDICATE_SYNONYMS: Array<[RegExp, string]> = [
  [/^(?:currently_)?(?:lives?|resides?|living|staying)_?in$/, 'lives_in'],
  [/^(?:currently_)?(?:lives?|resides?)_at$/, 'lives_in'],
  [/^(?:moved_(?:to|residence|home)|relocated_to)$/, 'lives_in'],
  [/^home(?:_(?:district|city|town))?$|^address$|^residence$/, 'lives_in'],
  [/^(?:works?|working)_?(?:at|for)$|^employed_at$|^workplace$/, 'works_at'],
  [/^works?_as$|^occupation$|^profession$|^job_title$/, 'works_as'],
]

export function canonicalPredicate(p: string): string {
  const norm = p.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?:is|has|get)s?_/, '')
  for (const [re, canon] of PREDICATE_SYNONYMS) if (re.test(norm)) return canon
  return norm
}

/** 单值状态谓词：同一 subject 同时只能有一个当前值（住址、雇主、职业、当前默认项……） */
const STATEFUL_PREDICATES = new Set(['lives_in', 'works_at', 'works_as'])
const STATEFUL_PREFIX_RE = /^(?:current|latest|default|release|deploy|publish|favorite_|prefers_[a-z0-9]|uses_[a-z0-9]|owns_[a-z0-9])/

export function isStatefulPredicate(p: string): boolean {
  const canon = canonicalPredicate(p)
  if (STATEFUL_PREDICATES.has(canon)) return true
  // 带方面后缀的写法（uses_test_framework）是单值属性；裸 uses/prefers/owns 可多值，不立即归档
  return STATEFUL_PREFIX_RE.test(canon) && !['uses', 'prefers', 'owns'].includes(canon)
}

/** 陈述时间：冲突裁决的唯一排序键；旧数据无 stated_at 时回退 created_at */
export const statedAtOf = (f: FactNode): string => f.stated_at ?? f.created_at
/** 生效时间：仅展示用；兼容旧数据的 valid_from */
export const effectiveFromOf = (f: FactNode): string => f.effective_from ?? f.valid_from ?? statedAtOf(f).slice(0, 10)

const isActive = (f: FactNode) => (f.lifecycle ?? 'stable') !== 'archived' && f.is_latest !== false
const subjectKey = (f: FactNode) => f.subject_id ?? f.subject.toLowerCase()
const objectKey = (f: FactNode) => f.object_id ?? f.object.toLowerCase()

/** 归档 older；有 newer 时建立 SUPERSEDES 版本链。旧事实留在图中供追溯，但移出向量索引、不再默认检索。 */
export function supersedeFact(
  graph: GraphStore,
  vectors: VectorStore,
  older: FactNode,
  opts: { reason: string; newer?: FactNode },
): void {
  const now = new Date().toISOString()
  const { reason, newer } = opts
  if (newer) {
    graph.addEdge({
      source_id: newer.node_id, target_id: older.node_id, edge_type: 'SUPERSEDES', weight: 1,
      created_at: now, metadata: { reason },
    })
    older.valid_to = effectiveFromOf(newer)
    older.superseded_by = newer.node_id
    newer.is_latest = true
  } else {
    older.valid_to = older.valid_to ?? effectiveFromOf(older)   // 明示作废且无替代：从其自身生效日起终止
  }
  Object.assign(older, { lifecycle: 'archived', is_latest: false, supersede_reason: reason, updated_at: now } as Partial<FactNode>)
  vectors.remove(older.node_id)
}

/**
 * 写入时冲突消解：每条 fact 落图（或被重新陈述）后立即调用。
 * 同 subject + 同规范谓词 + 不同 object，且谓词为单值状态属性 → 按 stated_at 归档较旧者；
 * 陈述时间相同则后写入者胜（与抽取的会话顺序一致）。
 * 返回被归档的事实（可能为空；传入事实本身过旧时也会被归档并包含在返回值中）。
 */
export function resolveWriteConflicts(graph: GraphStore, vectors: VectorStore, fact: FactNode): FactNode[] {
  if (!isStatefulPredicate(fact.predicate)) return []
  const canon = canonicalPredicate(fact.predicate)
  const superseded: FactNode[] = []
  for (const g of graph.getNodesByType<FactNode>('fact')) {
    if (g.node_id === fact.node_id || !isActive(g)) continue
    if (subjectKey(g) !== subjectKey(fact) || canonicalPredicate(g.predicate) !== canon || objectKey(g) === objectKey(fact)) continue
    const incomingNewer = statedAtOf(fact) >= statedAtOf(g)
    const [newer, older] = incomingNewer ? [fact, g] : [g, fact]
    supersedeFact(graph, vectors, older, { reason: 'stated_at_order', newer })
    superseded.push(older)
    if (!incomingNewer) break   // 传入的是更旧的陈述：归档它自身即可，同键的其余活跃事实都比它新
  }
  return superseded
}

/**
 * 旧数据迁移：为缺字段的 fact 回填 stated_at/effective_from，
 * 并按 stated_at 消解历史遗留的同键活跃冲突（在 runtime.create() 加载图谱后调用）。
 */
export function backfillFactTemporal(graph: GraphStore, vectors: VectorStore): { backfilled: number; superseded: number } {
  let backfilled = 0
  const facts = graph.getNodesByType<FactNode>('fact')
  for (const f of facts) {
    let changed = false
    if (!f.stated_at) { f.stated_at = f.created_at; changed = true }
    if (!f.effective_from) { f.effective_from = f.valid_from ?? f.created_at.slice(0, 10); changed = true }
    if (changed) { backfilled++; f.updated_at = new Date().toISOString() }
  }
  let superseded = 0
  for (const f of facts) {
    if ((f.lifecycle ?? 'stable') === 'archived' || f.is_latest === false) continue
    superseded += resolveWriteConflicts(graph, vectors, f).length
  }
  return { backfilled, superseded }
}

/**
 * 检索结果标注：同键（subject+规范谓词）出现多条活跃事实时，
 * stated_at 最新的一条标 'current'，其余标 'older'，供注入 prompt 时引导模型裁决。
 */
export function annotateCurrentFacts(nodes: AnyGraphNode[]): Map<string, 'current' | 'older'> {
  const groups = new Map<string, FactNode[]>()
  for (const n of nodes) {
    if (n.node_type !== 'fact') continue
    const key = `${subjectKey(n)}|${canonicalPredicate(n.predicate)}`
    const arr = groups.get(key) ?? []
    arr.push(n)
    groups.set(key, arr)
  }
  const out = new Map<string, 'current' | 'older'>()
  for (const arr of groups.values()) {
    if (arr.length < 2 || !isStatefulPredicate(arr[0].predicate)) continue
    const sorted = [...arr].sort((a, b) => statedAtOf(b).localeCompare(statedAtOf(a)))
    out.set(sorted[0].node_id, 'current')
    for (const f of sorted.slice(1)) out.set(f.node_id, 'older')
  }
  return out
}

/** 检索展示用的双时间轴标签：(stated 2026-10-25 13:51, since 2026-09-25) */
export function factTemporalLabel(f: FactNode): string {
  return `(stated ${statedAtOf(f).slice(0, 16).replace('T', ' ')}, since ${effectiveFromOf(f)})`
}
