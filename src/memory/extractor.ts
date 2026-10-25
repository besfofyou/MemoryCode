import type { ModelAdapter, ChatMessage } from '../types.js'
import type {
  ExtractionResult, PersonNode, EventNode,
  ConceptNode, ClaimNode, FactNode,
  AnyGraphNode, EdgeType,
} from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_PROMPT } from './cogmem-prompts.js'
import { stableId, normalizeConceptName, canonicalPersonName, resolveRelativeTime, isLowValueConceptName } from './graph-ids.js'
import { canonicalPredicate, resolveWriteConflicts, supersedeFact } from './fact-conflicts.js'
import { extractJsonObject, fill } from './json-util.js'
import { memoryModelText } from './model-call.js'
import { sanitizeMemoryContent, validateMemoryWrite } from './safety.js'
import { tokenize } from './filesystem.js'

type Ctx = {
  sessionId: string
  now: string
  /** 同一窗口内逐条递增的陈述序号：保证 stated_at 严格按会话顺序单调递增 */
  statedSeq: number
  sourceText: string
  batch: { id: string; text: string }[]
  created: { n: number }
}

/**
 * 结构化信息抽取器（对应 CogMem 的 Indexer）
 *
 * 从对话历史中抽取 Person/Event/Concept/Claim/Fact 节点，
 * 写入 GraphStore 并索引到 VectorStore。
 */
export class CogMemExtractor {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectorStore: VectorStore,
    private readonly model: ModelAdapter,
  ) {}

  /**
   * 从一组对话消息中抽取结构化记忆
   */
  async extractFromMessages(
    messages: ChatMessage[],
    sessionId: string,
  ): Promise<{ nodesCreated: number; newEventIds: string[]; touchedFactIds: string[] }> {
    const sessionDate = new Date().toISOString().slice(0, 10)
    const out = { nodesCreated: 0, newEventIds: [] as string[], touchedFactIds: [] as string[] }
    for (const text of chunkMessages(messages, 6000, 4)) {          // 按窗口切分，保证会话末尾一定被抽取
      if (text.length < 50) continue
      const x = await this.callLLM(text, sessionDate)
      if (!x) continue
      const r = await this.writeExtraction(x, text, sessionId, sessionDate)
      out.nodesCreated += r.nodesCreated; out.newEventIds.push(...r.newEventIds); out.touchedFactIds.push(...r.touchedFactIds)
    }
    return out
  }

  private async callLLM(text: string, sessionDate: string): Promise<ExtractionResult | null> {
    try {
      const content = await memoryModelText(this.model, [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: fill(EXTRACTION_USER_PROMPT, { text, session_date: sessionDate }) },
      ])
      if (!content) return null
      const p = extractJsonObject(content) as Partial<ExtractionResult> | null
      if (!p) return null
      const arr = <T>(v: unknown) => (Array.isArray(v) ? v : []) as T[]
      return {
        events: arr(p.events), facts: arr(p.facts), claims: arr(p.claims),
        invalidations: arr(p.invalidations), persons: arr(p.persons), concepts: arr(p.concepts),
      }
    } catch { return null }
  }

  /** 陈述时间：窗口基准时刻 + 单调递增序号，严格保持会话内的先后顺序（后陈述 ≥ 先陈述） */
  private nextStatedAt(ctx: Ctx): string {
    const iso = new Date(Date.parse(ctx.now) + ctx.statedSeq).toISOString()
    ctx.statedSeq++
    return iso
  }

  private async writeExtraction(x: ExtractionResult, sourceText: string, sessionId: string, sessionDate: string) {
    const ctx: Ctx = { sessionId, now: new Date().toISOString(), statedSeq: 0, sourceText, batch: [], created: { n: 0 } }
    const newEventIds: string[] = [], touchedFactIds: string[] = []

    // 顶层 concepts 的描述表（按归一化名索引），供事件/事实/声明中出现的同名概念补齐描述
    const conceptMeta = new Map<string, string>()
    for (const c of x.concepts) {
      const name = clean(c?.name)
      const desc = clean(c?.description, 160)
      if (!name) continue
      const key = normalizeConceptName(name)
      if (isLowValueConceptName(key)) continue
      if (desc && !conceptMeta.has(key)) conceptMeta.set(key, desc)
    }
    const descFor = (name: string): string | undefined => conceptMeta.get(normalizeConceptName(clean(name)))

    for (const p of x.persons) if (p?.name) this.ensurePerson(p.name, ctx, p.aliases ?? [])
    for (const c of x.concepts) if (c?.name) this.ensureConcept(c.name, ctx, c.description)

    // ---- Event（情景记忆）----
    for (const e of x.events) {
      const title = clean(e.title ?? e.description)
      if (!title) continue
      const id = stableId('event', sessionId, title)
      if (this.graph.getNode(id)) continue                                       // 幂等
      const people = (e.participants?.length ? e.participants : ['User'])
        .map(n => this.ensurePerson(n, ctx)).filter((p): p is PersonNode => !!p)
      const concepts = (e.concepts ?? [])
        .map(n => this.ensureConcept(n, ctx, descFor(n))).filter((c): c is ConceptNode => !!c)
      const timeRaw = typeof e.time === 'string' && e.time.trim() ? e.time.trim() : undefined
      const desc = clean(e.description) || title
      this.add({
        node_id: id, node_type: 'event', title, description: desc,
        participants: people.map(p => p.node_id), concepts: concepts.map(c => c.node_id),
        time_expression: timeRaw, resolved_time: resolveRelativeTime(timeRaw, sessionDate), session_time: sessionDate,
        archived: false, evidence: pickEvidence(e.evidence, sourceText, `${title} ${desc}`),
        created_at: ctx.now, updated_at: ctx.now, source_session_id: sessionId,
        embedding_text: `Event: ${title}. ${desc}. Concepts: ${concepts.map(c => c.name).join(', ')}`,
      } satisfies EventNode, ctx)
      people.forEach((p, i) => this.edge(p.node_id, id, i === 0 ? 'PARTICIPATED_IN' : 'MENTIONED_IN', i === 0 ? 1 : 0.5, ctx.now))
      concepts.forEach(c => this.edge(id, c.node_id, 'ABOUT_CONCEPT', 1, ctx.now))   // = CogMem INVOLVES
      newEventIds.push(id)
    }

    // ---- Fact（抽取阶段只算候选语义记忆）----
    for (const f of x.facts) {
      const subject = clean(f.subject), object = clean(f.object)
      const predicate = clean(f.predicate).toLowerCase().replace(/\s+/g, '_').slice(0, 60)
      if (!subject || !predicate || !object) continue                            // = CogMem skip_incomplete_facts
      // P0 防回写：assistant 的推理性回答不当场抽成 fact——LLM 声明 source=assistant，
      // 或引文未经验证且证据落在 assistant 发言行上，均视为 assistant 来源并跳过
      const ev = pickEvidenceWithOrigin(f.evidence, sourceText, `${subject} ${predicate} ${object}`)
      if (f.source === 'assistant' || ev.origin === 'assistant') continue
      // 先解析 object：低价值 object 直接跳过整条 fact，避免把 subject 建成孤儿概念
      const obj = this.ensureConcept(object, ctx, descFor(object))
      if (!obj) continue
      const subj = this.findPersonByName(canonicalPersonName(subject)) ?? this.ensureConcept(subject, ctx, descFor(subject))
      if (!subj) continue
      const id = stableId('fact', subj.node_id, predicate, obj.node_id)
      const existing = this.graph.getNode(id)
      if (existing?.node_type === 'fact') {                                      // 跨会话重复出现：记录次数，供第 2 点晋升
        existing.mention_count = (existing.mention_count ?? 1) + 1
        existing.source_sessions = [...new Set([...(existing.source_sessions ?? []), sessionId])]
        const wasArchived = (existing.lifecycle ?? 'stable') === 'archived' || existing.is_latest === false
        existing.stated_at = this.nextStatedAt(ctx)                             // 重新陈述 → 刷新陈述时间（裁决依据）
        if (ev.lines[0] && !(existing.evidence ?? []).includes(ev.lines[0])) {
          existing.evidence = [...(existing.evidence ?? []), ev.lines[0]].slice(-3)
        }
        if (wasArchived) {
          // 用户重新陈述已归档的事实 → 复活：这是一条新的用户陈述，足以推翻现行值（按 stated_at 再裁决）
          existing.lifecycle = 'candidate'
          existing.is_latest = true
          existing.valid_to = undefined
          existing.superseded_by = undefined
          existing.supersede_reason = undefined
          ctx.batch.push({ id: existing.node_id, text: existing.embedding_text })   // 归档时向量已删，重建
        }
        existing.updated_at = ctx.now
        touchedFactIds.push(id)
        resolveWriteConflicts(this.graph, this.vectorStore, existing)           // 重新陈述也可能改变当前值
        continue
      }
      const desc = `${subject} ${predicate.replace(/_/g, ' ')} ${object}`
      // P0 时间双轴：stated_at=陈述时间（裁决依据）；effective_from=生效时间（仅展示）
      const effectiveFrom = resolveRelativeTime(f.effective_from, sessionDate) ?? sessionDate
      const node: FactNode = {
        node_id: id, node_type: 'fact', subject, predicate, object, description: desc,
        subject_id: subj.node_id, object_id: obj.node_id,
        confidence: 0.6, lifecycle: 'candidate', is_latest: true,
        stated_at: this.nextStatedAt(ctx), effective_from: effectiveFrom, valid_from: effectiveFrom,
        mention_count: 1, source_sessions: [sessionId], supported_by_event_ids: [],
        evidence: ev.lines,
        created_at: ctx.now, updated_at: ctx.now, source_session_id: sessionId,
        embedding_text: `Fact: ${desc}`,
      }
      this.add(node, ctx)
      this.edge(subj.node_id, id, 'HAS_ATTRIBUTE', 1, ctx.now)
      this.edge(id, obj.node_id, 'ABOUT_CONCEPT', 1, ctx.now)
      touchedFactIds.push(id)
      // P0 写入时冲突消解：同 subject+规范谓词的单值状态事实，立即按 stated_at 归档较旧者
      resolveWriteConflicts(this.graph, this.vectorStore, node)
    }

    // ---- Invalidation（用户明示作废：立即归档匹配的活跃事实，不依赖事后 reconcile）----
    for (const iv of x.invalidations) {
      const subject = clean(iv.subject), predicate = clean(iv.predicate)
      if (!subject || !predicate) continue
      const objWanted = clean(iv.object).toLowerCase()
      const subjPerson = this.findPersonByName(canonicalPersonName(subject))
      const subjConceptId = stableId('concept', normalizeConceptName(subject))
      const canon = canonicalPredicate(predicate)
      for (const g of this.graph.getNodesByType<FactNode>('fact')) {
        if ((g.lifecycle ?? 'stable') === 'archived' || g.is_latest === false) continue
        if (subjPerson && g.subject_id !== subjPerson.node_id && g.subject_id !== subjConceptId
          && g.subject.toLowerCase() !== subject.toLowerCase()) continue
        if (subjPerson === null && g.subject.toLowerCase() !== subject.toLowerCase()) continue
        if (canonicalPredicate(g.predicate) !== canon) continue
        if (objWanted && normalizeConceptName(g.object) !== normalizeConceptName(objWanted)) continue
        supersedeFact(this.graph, this.vectorStore, g, { reason: 'user_invalidation' })
        touchedFactIds.push(g.node_id)
      }
    }

    // ---- Claim（两跳结构：Source -CLAIMS-> Claim -ABOUT-> Target）----
    for (const c of x.claims) {
      const content = clean(c.content)
      if (content.length < 3) continue
      const src = this.ensurePerson(c.source || 'User', ctx)
      if (!src) continue
      const tgt = c.target ? (this.findPersonByName(canonicalPersonName(c.target)) ?? this.ensureConcept(c.target, ctx, descFor(c.target))) : null
      const id = stableId('claim', src.node_id, tgt?.node_id ?? '', content)
      if (this.graph.getNode(id)) continue
      // P0 防回写：assistant 自己的推断/结论按 claim 保留但降权（candidate + 低置信度），
      // 不进 stable、不当成事实——助手推理只是推理，可能包含幻觉
      const assistantOrigin = src.canonical_name === 'Assistant'
      this.add({
        node_id: id, node_type: 'claim', source_person_id: src.node_id, target: c.target, target_id: tgt?.node_id,
        content, confidence: assistantOrigin ? 0.4 : 0.6, lifecycle: assistantOrigin ? 'candidate' : 'stable',
        evidence: pickEvidenceWithOrigin(c.evidence, sourceText, content).lines,
        created_at: ctx.now, updated_at: ctx.now, source_session_id: sessionId,
        embedding_text: `Claim by ${src.canonical_name}${c.target ? ` about ${c.target}` : ''}: ${content}`,
      } satisfies ClaimNode, ctx)
      this.edge(src.node_id, id, 'CLAIMS', 1, ctx.now)
      if (tgt) this.edge(id, tgt.node_id, 'ABOUT', 1, ctx.now)
    }

    if (ctx.batch.length) await this.vectorStore.addBatch(ctx.batch)   // 失败不抛出，见第 5 点
    return { nodesCreated: ctx.created.n, newEventIds, touchedFactIds }
  }

  private add(node: AnyGraphNode, ctx: Ctx) { this.graph.addNode(node); ctx.batch.push({ id: node.node_id, text: node.embedding_text }); ctx.created.n++ }
  private edge(s: string, t: string, edge_type: EdgeType, weight: number, created_at: string) {
    this.graph.addEdge({ source_id: s, target_id: t, edge_type, weight, created_at })
  }

  private ensurePerson(name: string, ctx: Ctx, aliases: string[] = []): PersonNode | null {
    const canonical = canonicalPersonName(clean(name))
    if (!canonical) return null
    const hit = this.findPersonByName(canonical) ?? aliases.map(a => this.findPersonByName(canonicalPersonName(a))).find(Boolean) ?? null
    if (hit) { for (const a of aliases) if (!hit.aliases.includes(a)) hit.aliases.push(a); return hit }
    const node: PersonNode = {
      node_id: stableId('p', canonical), node_type: 'person', canonical_name: canonical, aliases, description: `Person: ${canonical}`,
      created_at: ctx.now, updated_at: ctx.now, source_session_id: ctx.sessionId, embedding_text: [canonical, ...aliases].join(' '),
    }
    this.add(node, ctx); return node
  }

  /**
   * 概念层写入（对应 CogMem ConceptManager.resolve + indexer 的 Concept 节点创建）：
   * - 低价值概念（泛称词/测量值/日期/引文）不实例化为节点；
   * - 原始写法与归一化名不同时记录为别名；
   * - 旧节点描述是占位符（等于名称/为空）时用新描述刷新并重建向量索引；
   * - 每次命中累计 mention_count（供后续概念合并/排序使用）。
   */
  private ensureConcept(name: string, ctx: Ctx, description?: string): ConceptNode | null {
    const raw = clean(name, 80)
    if (!raw) return null
    const norm = normalizeConceptName(raw)
    if (norm.length < 2 || isLowValueConceptName(norm)) return null
    const id = stableId('concept', norm)
    const desc = clean(description, 160)

    const hit = this.graph.getNode(id)
    if (hit?.node_type === 'concept') {
      if (desc && (!hit.description || hit.description === hit.name) && hit.description !== desc) {
        hit.description = desc
        hit.embedding_text = `Concept: ${hit.name}. ${desc}`
        hit.updated_at = ctx.now
        ctx.batch.push({ id: hit.node_id, text: hit.embedding_text })      // upsert 语义，重建向量
      }
      const lowerRaw = raw.toLowerCase()
      if (raw !== hit.name && !(hit.aliases ?? []).some(a => a.toLowerCase() === lowerRaw)) {
        hit.aliases = [...(hit.aliases ?? []), raw]
        hit.updated_at = ctx.now
      }
      hit.mention_count = (hit.mention_count ?? 0) + 1
      return hit
    }

    const fallback = raw !== norm ? `${norm} (${raw})` : norm
    const node: ConceptNode = {
      node_id: id, node_type: 'concept', name: norm, aliases: raw !== norm ? [raw] : [],
      description: desc || norm, mention_count: 1,
      created_at: ctx.now, updated_at: ctx.now, source_session_id: ctx.sessionId,
      embedding_text: `Concept: ${norm}. ${desc || fallback}`,
    }
    this.add(node, ctx); return node
  }

  private findPersonByName(name: string): PersonNode | null {
    const lower = name.toLowerCase().trim()
    for (const node of this.graph.getNodesByType<PersonNode>('person')) {
      if (node.canonical_name.toLowerCase() === lower) return node
      if (node.aliases.some(a => a.toLowerCase() === lower)) return node
    }
    return null
  }
}

// ---- 辅助函数 ----

function clean(v: unknown, max = 300): string {
  if (typeof v !== 'string') return ''
  const s = sanitizeMemoryContent(v.replace(/\s+/g, ' ').trim()).slice(0, max)
  return s && validateMemoryWrite(s).allowed ? s : ''
}

/**
 * 证据选取 + 发言者识别（chunk 文本每行以 "[user]: " / "[assistant]: " 开头）：
 * - LLM 引文必须真的出现在原文中；引文验证通过时，以引文所在行判断来源；
 * - 引文未验证通过时按词重叠找最相关的一行（防幻觉引文），该行的发言者即证据来源。
 */
function pickEvidenceWithOrigin(quote: unknown, source: string, key: string): { lines: string[]; origin: 'user' | 'assistant' | 'unknown' } {
  const speakerOf = (line: string): 'user' | 'assistant' | 'unknown' =>
    /^\[assistant\]:/i.test(line) ? 'assistant' : /^\[user\]:/i.test(line) ? 'user' : 'unknown'
  if (typeof quote === 'string' && quote.trim().length >= 8) {
    const q = quote.trim()
    const line = source.split('\n').find(l => l.includes(q))
    if (line) return { lines: [q.slice(0, 300)], origin: speakerOf(line) }
  }
  const keyTokens = new Set(tokenize(key))
  let best = '', bestScore = 0
  for (const line of source.split('\n')) {
    const score = tokenize(line).filter(t => keyTokens.has(t)).length
    if (score > bestScore) { best = line; bestScore = score }
  }
  return bestScore >= 2 ? { lines: [best.slice(0, 300)], origin: speakerOf(best) } : { lines: [], origin: 'unknown' }
}

/** 兼容旧调用：只取证据行 */
function pickEvidence(quote: unknown, source: string, key: string): string[] {
  return pickEvidenceWithOrigin(quote, source, key).lines
}

/** 从最新的消息往回切窗口，最多 maxWindows 个 */
function chunkMessages(messages: ChatMessage[], windowChars = 6000, maxWindows = 4): string[] {
  const lines = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${m.content.length > 1500 ? `${m.content.slice(0, 1500)} …[truncated]` : m.content}`)
  const windows: string[] = []
  let cur = ''
  for (let i = lines.length - 1; i >= 0 && windows.length < maxWindows; i--) {
    if (cur && cur.length + lines[i].length > windowChars) { windows.push(cur); cur = '' }
    cur = cur ? `${lines[i]}\n${cur}` : lines[i]
  }
  if (cur && windows.length < maxWindows) windows.push(cur)
  return windows.reverse()
}
