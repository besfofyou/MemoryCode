import type { ModelAdapter } from '../types.js'
import type { EventNode, FactNode, PersonNode, ConceptNode } from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { stableId, canonicalPersonName } from './graph-ids.js'
import { resolveWriteConflicts } from './fact-conflicts.js'
import { extractJsonObject, fill } from './json-util.js'
import { memoryModelText } from './model-call.js'
import { CONSOLIDATION_CLUSTER_SYSTEM, CONSOLIDATION_CLUSTER_USER } from './cogmem-prompts.js'

type Cluster = { personId: string; conceptId: string; events: EventNode[] }
type Synth = { content: string; predicate: string; confidence: number; valid_from?: string; events: EventNode[] }
const evTime = (e: EventNode) => e.resolved_time ?? e.session_time ?? e.created_at

/**
 * 记忆巩固引擎
 *
 * 按人物 × 概念聚类，每簇至少 minEvents 个事件才合成；
 * 合成出的事实用确定性 ID，有 HAS_ATTRIBUTE / SUPPORTED_BY 边；
 * 默认不归档原始事件（与 CogMem archive_original_events=False 一致）。
 */
export class MemoryConsolidator {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectorStore: VectorStore,
    private readonly model: ModelAdapter,
  ) {}

  async consolidate(opts: { minEvents?: number; maxClusters?: number } = {}): Promise<{
    factsCreated: number
    factsUpdated: number
    promoted: number
    touchedFactIds: string[]
  }> {
    const minEvents = opts.minEvents ?? 3                       // = CogMem min_events（按聚类计）
    const touchedFactIds: string[] = []
    const promoted = this.promoteRepeatedCandidates(touchedFactIds)

    const tasks = this.clusterEvents()
      .filter(c => c.events.length >= minEvents && this.hasUnconsolidatedEvents(c))
      // P0 防回写：助手自身的回答/行为是推理产物，合成出的"助手行为事实"会固化推理错误；
      // 这类约定应进技能库（procedural），不进用户语义事实图谱
      .filter(c => !this.isAssistantPerson(c.personId))
      .sort((a, b) => maxTime(b.events).localeCompare(maxTime(a.events)))
      .slice(0, opts.maxClusters ?? 5)                         // 限制每次会话结束时的 LLM 调用数

    let factsCreated = 0, factsUpdated = 0
    const batch: { id: string; text: string }[] = []
    for (const task of tasks) {
      const s = await this.synthesize(task)
      if (!s) continue
      const r = this.upsertFact(task, s, batch)
      touchedFactIds.push(r.id)
      if (r.created) factsCreated++; else factsUpdated++
    }
    if (batch.length) await this.vectorStore.addBatch(batch)
    return { factsCreated, factsUpdated, promoted, touchedFactIds }
  }

  /** 主参与者是否是 Assistant 本人（按规范化人名判定，含别名归一） */
  private isAssistantPerson(personId: string): boolean {
    const node = this.graph.getNode(personId)
    return node?.node_type === 'person' && node.canonical_name === canonicalPersonName('Assistant')
  }

  /** = CogMem _get_participated_events + _cluster_events_by_concept；只取主参与者 */
  private clusterEvents(): Cluster[] {
    const map = new Map<string, Cluster>()
    for (const e of this.graph.getNodesByType<EventNode>('event')) {
      const personId = e.participants[0]
      if (!personId) continue
      for (const conceptId of e.concepts ?? []) {
        const key = `${personId}|${conceptId}`
        const c = map.get(key) ?? { personId, conceptId, events: [] }
        c.events.push(e); map.set(key, c)
      }
    }
    return [...map.values()]
  }

  /** CogMem 遇到已有 stable Fact 就永久跳过；改成"有新事件未被覆盖才重新合成"，支持增量巩固 */
  private hasUnconsolidatedEvents(c: Cluster): boolean {
    const covered = new Set<string>()
    for (const f of this.graph.getNodesByType<FactNode>('fact')) {
      if ((f.lifecycle ?? 'stable') !== 'stable' || f.subject_id !== c.personId || f.object_id !== c.conceptId) continue
      for (const id of f.derived_from_event_ids ?? f.supported_by_event_ids) covered.add(id)
    }
    return c.events.some(e => !covered.has(e.node_id))
  }

  /** 编码助手场景的补充：同一候选事实在 ≥2 个会话中被独立抽到，直接晋升为 stable */
  private promoteRepeatedCandidates(touched: string[]): number {
    let n = 0
    for (const f of this.graph.getNodesByType<FactNode>('fact')) {
      if (f.lifecycle !== 'candidate' || (f.source_sessions?.length ?? 1) < 2) continue
      f.lifecycle = 'stable'; f.confidence = Math.max(f.confidence, 0.8); f.updated_at = new Date().toISOString()
      touched.push(f.node_id); n++
    }
    return n
  }

  private async synthesize(c: Cluster): Promise<Synth | null> {
    const person = this.graph.getNode(c.personId), concept = this.graph.getNode(c.conceptId)
    if (person?.node_type !== 'person' || concept?.node_type !== 'concept') return null
    const events = [...c.events].sort((a, b) => evTime(b).localeCompare(evTime(a))).slice(0, 12)
    const user = fill(CONSOLIDATION_CLUSTER_USER, {
      person_name: person.canonical_name,
      concept_name: concept.name,
      events_json: JSON.stringify(events.map(e => ({ id: e.node_id, title: e.title, description: e.description, time: e.resolved_time ?? e.time_expression ?? e.session_time }))),
    })
    try {
      const content = await memoryModelText(this.model, [{ role: 'system', content: CONSOLIDATION_CLUSTER_SYSTEM }, { role: 'user', content: user }])
      if (!content) return null
      const d = extractJsonObject(content) as { skip?: boolean; content?: string; predicate?: string; confidence?: number; valid_from?: string } | null
      if (!d || d.skip || !d.content || !d.predicate) return null           // = CogMem 必填字段校验
      return {
        content: String(d.content).slice(0, 300),
        predicate: String(d.predicate).toLowerCase().replace(/\s+/g, '_').slice(0, 60),
        confidence: Math.max(0, Math.min(1, Number(d.confidence ?? 0.7))),
        valid_from: typeof d.valid_from === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(d.valid_from) ? d.valid_from : undefined,
        events,
      }
    } catch { return null }
  }

  /** = CogMem _create_fact_node：确定性 ID、HAS_ATTRIBUTE、SUPPORTED_BY 最多 5 条、importance、stable */
  private upsertFact(c: Cluster, s: Synth, batch: { id: string; text: string }[]) {
    const now = new Date().toISOString()
    const person = this.graph.getNode(c.personId) as PersonNode
    const concept = this.graph.getNode(c.conceptId) as ConceptNode
    const id = stableId('fact', c.personId, s.predicate, c.conceptId)        // = _make_fact_id(person, concept, predicate)
    const support = s.events.slice(0, 5)
    const importance = Math.min(1, 0.4 * (Math.min(c.events.length, 10) / 5) + 0.4 * s.confidence + 0.2)
    const evidence = [...new Set(support.flatMap(e => e.evidence ?? []))].slice(0, 3)
    const embedding_text = `${person.canonical_name} ${s.predicate.replace(/_/g, ' ')} ${concept.name}: ${s.content}`
    const derived = c.events.map(e => e.node_id)

    const existing = this.graph.getNode(id)
    const created = existing?.node_type !== 'fact'
    if (existing?.node_type === 'fact') {
      Object.assign(existing, {
        description: s.content, confidence: Math.max(existing.confidence, s.confidence), importance, evidence,
        lifecycle: 'stable', is_latest: true, updated_at: now, embedding_text,
        // 陈述时间不刷新：合成事实的裁决权重不得超过用户此后的亲口陈述
        derived_from_event_ids: [...new Set([...(existing.derived_from_event_ids ?? []), ...derived])],
        supported_by_event_ids: support.map(e => e.node_id),
      })
    } else {
      const effectiveFrom = s.valid_from ?? evTime(s.events[s.events.length - 1]).slice(0, 10)
      this.graph.addNode({
        node_id: id, node_type: 'fact', subject: person.canonical_name, predicate: s.predicate, object: concept.name,
        subject_id: c.personId, object_id: c.conceptId, description: s.content,
        confidence: s.confidence, lifecycle: 'stable', is_latest: true, importance,
        stated_at: now, effective_from: effectiveFrom, valid_from: effectiveFrom,
        supported_by_event_ids: support.map(e => e.node_id), derived_from_event_ids: derived, evidence,
        created_at: now, updated_at: now, source_session_id: 'consolidation', embedding_text,
      } satisfies FactNode)
      this.graph.addEdge({ source_id: c.personId, target_id: id, edge_type: 'HAS_ATTRIBUTE', weight: s.confidence, created_at: now })
      this.graph.addEdge({ source_id: id, target_id: c.conceptId, edge_type: 'ABOUT_CONCEPT', weight: 1, created_at: now })
    }
    for (const e of support) this.graph.addEdge({ source_id: id, target_id: e.node_id, edge_type: 'SUPPORTED_BY', weight: 1, created_at: now })
    batch.push({ id, text: embedding_text })
    // P0 写入时冲突消解：合成事实与既有同键活跃事实的冲突当刻裁决（按 stated_at）
    const factNode = this.graph.getNode(id)
    if (factNode?.node_type === 'fact') resolveWriteConflicts(this.graph, this.vectorStore, factNode)
    // 注意：不再把原始 Event 标为 archived（与 CogMem 默认 archive_original_events=False 一致）
    return { id, created }
  }
}

function maxTime(events: EventNode[]) { return events.map(evTime).sort().at(-1) ?? '' }
