import { readFile, rename } from 'node:fs/promises'
import type { Skill, SkillBankData, SkillLifecycle } from './types.js'
import { tokenize, tokenSignature, setOverlap, latinTokensDuplicate } from './filesystem.js'
import { writeJsonAtomic } from './fs-util.js'

/** retired 墓碑上限：淘汰记录只保留最近这么多条供去重参考，防止 skill-bank.json 无限增长 */
export const MAX_RETIRED_SKILLS = 40

function skillDefaults(lifecycle: SkillLifecycle = 'active'): Partial<Skill> {
  const now = new Date().toISOString()
  return {
    usage_count: 0,
    success_count: 0,
    lifecycle,
    parent_id: null,
    generation: 0,
    children: [],
    recent_failures: [],
    tags: [],
    when_to_apply: '',
    createdAt: now,
    updatedAt: now,
  }
}

export type RetrieveOptions = {
  fitness?: (s: Skill) => number   // 由 ForgeEngine 注入，复用 warmup 逻辑
  exploreSlots?: number            // 留给 trial skill 的探索名额
  random?: () => number            // 探索槽加权采样的随机源（测试可注入确定性序列）
}

export class SkillBank {
  data: SkillBankData
  private readonly filePath: string

  constructor(filePath: string, data?: Partial<SkillBankData>) {
    this.filePath = filePath
    const raw = data ?? {}
    this.data = {
      general_skills: Array.isArray(raw.general_skills) ? [...raw.general_skills] : [],
      task_specific_skills: Object.fromEntries(
        Object.entries(raw.task_specific_skills ?? {})
          .map(([k, v]) => [k, Array.isArray(v) ? [...v] : []]),
      ),
      common_mistakes: Array.isArray(raw.common_mistakes) ? [...raw.common_mistakes] : [],
    }
    // 确保所有 skill 具备运行时字段
    for (const skill of this.allSkills(true)) {
      this.ensureFields(skill)
    }
  }

  // —— 从 JSON 文件加载 ——
  static async fromJSON(filePath: string): Promise<SkillBank> {
    let content: string
    try { content = await readFile(filePath, 'utf8') }
    catch (e: any) { if (e?.code === 'ENOENT') return new SkillBank(filePath); throw e }
    try { return new SkillBank(filePath, JSON.parse(content)) }
    catch {
      await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {})  // 留底，不覆盖
      return new SkillBank(filePath)
    }
  }

  // —— 持久化 ——
  async save(): Promise<void> { await writeJsonAtomic(this.filePath, this.data) }

  // —— 确保字段完整 ——
  ensureFields(skill: Skill, lifecycle?: SkillLifecycle): Skill {
    for (const [key, value] of Object.entries(skillDefaults(lifecycle))) {
      if ((skill as any)[key] === undefined) (skill as any)[key] = value
    }
    return skill
  }

  // —— 遍历所有 skill ——
  allSkills(includeRetired = false): Skill[] {
    const skills = [
      ...this.data.general_skills,
      ...Object.values(this.data.task_specific_skills).flat(),
    ]
    return includeRetired ? skills : skills.filter(s => s.lifecycle !== 'retired')
  }

  get size(): number { return this.allSkills().length }

  getSkill(skillId: string): Skill | null {
    return this.allSkills(true).find(s => s.skill_id === skillId) ?? null
  }

  skillIds(): Set<string> {
    return new Set(this.allSkills(true).map(s => s.skill_id).filter(Boolean))
  }

  // —— 语义去重 ——
  // 双通道：全量 token 重叠（中文措辞稀释后阈值从 0.6 放宽到 0.5），
  // 或拉丁 token（命令/路径/标识符）高度重合——后者抓「同一操作换个说法」的重复
  findNearDuplicate(text: string, threshold = 0.5): Skill | null {
    const a = tokenSignature(text)
    if (!a.all.size) return null
    for (const s of this.allSkills(true)) {
      const b = tokenSignature(`${s.title} ${s.principle}`)
      if (!b.all.size) continue
      if (setOverlap(a.all, b.all) > threshold) return s
      if (latinTokensDuplicate(a, b)) return s
    }
    return null
  }

  /**
   * 事后合并存量近重复 skill。
   *
   * 入库时的 findNearDuplicate 只能拦截增量，拦不了存量池里已并存的重复
   * （蒸馏器换个措辞就会把同一经验再学一遍，usage 被分流、谁也到不了晋升阈值）。
   * 每个进化周期调用一次：重复对内选胜者（生命周期更成熟 → fitness 更高 → usage 更多 → 文本更全），
   * 败者的 usage/success/recent_failures/tags/谱系并入胜者，然后软淘汰为墓碑——
   * 墓碑继续拦截蒸馏器重学，同时不再占据检索名额。
   *
   * 为保护已验证技能的统计不被污染，仅当重复对中至少一方是 trial 时才合并。
   * 返回 { loserId, winnerId } 列表（loser 已被 retire）。
   */
  mergeNearDuplicates(
    fitness: (s: Skill) => number,
    threshold = 0.5,
  ): Array<{ loserId: string; winnerId: string }> {
    const live = this.allSkills()
    const signatures = new Map<string, ReturnType<typeof tokenSignature>>()
    const sigOf = (s: Skill) => {
      let sig = signatures.get(s.skill_id)
      if (!sig) {
        sig = tokenSignature(`${s.title} ${s.principle}`)
        signatures.set(s.skill_id, sig)
      }
      return sig
    }
    const absorbed = new Set<string>()
    const mergedPairs: Array<{ loserId: string; winnerId: string }> = []

    for (let i = 0; i < live.length; i++) {
      const a = live[i]!
      if (absorbed.has(a.skill_id)) continue
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j]!
        if (absorbed.has(b.skill_id)) continue
        if (a.lifecycle !== 'trial' && b.lifecycle !== 'trial') continue
        const sa = sigOf(a)
        const sb = sigOf(b)
        if (!sa.all.size || !sb.all.size) continue
        if (setOverlap(sa.all, sb.all) <= threshold && !latinTokensDuplicate(sa, sb)) continue

        const winner = this.pickMergeWinner(a, b, fitness)
        const loser = winner === a ? b : a
        this.absorbInto(winner, loser)
        this.retire(loser.skill_id)
        absorbed.add(loser.skill_id)
        mergedPairs.push({ loserId: loser.skill_id, winnerId: winner.skill_id })
      }
    }
    return mergedPairs
  }

  /** 合并胜者选择：生命周期更成熟者优先，其次 fitness、usage，最后文本更全者 */
  private pickMergeWinner(a: Skill, b: Skill, fitness: (s: Skill) => number): Skill {
    const rank: Record<SkillLifecycle, number> = { trial: 0, active: 1, stable: 2, retired: -1 }
    if (rank[a.lifecycle] !== rank[b.lifecycle]) return rank[a.lifecycle] > rank[b.lifecycle] ? a : b
    const fa = fitness(a)
    const fb = fitness(b)
    if (fa !== fb) return fa > fb ? a : b
    if ((a.usage_count ?? 0) !== (b.usage_count ?? 0)) return (a.usage_count ?? 0) > (b.usage_count ?? 0) ? a : b
    return a.principle.length >= b.principle.length ? a : b
  }

  /** 把败者的统计、标签与谱系并入胜者（调用方负责随后 retire 败者） */
  private absorbInto(winner: Skill, loser: Skill): void {
    winner.usage_count = (winner.usage_count ?? 0) + (loser.usage_count ?? 0)
    winner.success_count = (winner.success_count ?? 0) + (loser.success_count ?? 0)
    winner.recent_failures = [...(winner.recent_failures ?? []), ...(loser.recent_failures ?? [])].slice(-15)
    winner.tags = [...new Set([...(winner.tags ?? []), ...(loser.tags ?? [])])]
    if (!winner.when_to_apply && loser.when_to_apply) winner.when_to_apply = loser.when_to_apply

    // 谱系重接：败者的子技能改挂胜者；败者的父技能改指向胜者
    for (const childId of loser.children ?? []) {
      if (childId === winner.skill_id) continue
      const child = this.getSkill(childId)
      if (child) child.parent_id = winner.skill_id
      if (!winner.children.includes(childId)) winner.children.push(childId)
    }
    if (loser.parent_id && loser.parent_id !== winner.skill_id) {
      const parent = this.getSkill(loser.parent_id)
      if (parent) {
        parent.children = (parent.children ?? []).filter(id => id !== loser.skill_id)
        if (!parent.children.includes(winner.skill_id)) parent.children.push(winner.skill_id)
      }
      if (!winner.parent_id) winner.parent_id = loser.parent_id
    }
    // 处理 winner 与 loser 互为父子/同节点的边角
    winner.children = (winner.children ?? []).filter(id => id !== loser.skill_id)
    if (winner.parent_id === loser.skill_id) winner.parent_id = loser.parent_id ?? null
    winner.updatedAt = new Date().toISOString()
  }

  // —— 任务类型检测（面向编码场景） ——
  detectTaskType(userRequest: string): string {
    const text = userRequest.toLowerCase()
    const groups = this.data.task_specific_skills
    if (!Object.keys(groups).length) return 'general'

    const scores: Record<string, number> = {}
    for (const group of Object.keys(groups)) {
      // 将 group 名拆分为关键词
      const keywords = group.replace(/[_-]/g, ' ').split(/\s+/)
      scores[group] = keywords.reduce(
        (sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0
      )
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
    return best && best[1] > 0 ? best[0] : Object.keys(groups)[0] ?? 'general'
  }

  private relevance(queryTokens: Set<string>, s: Skill): number {
    const toks = new Set(tokenize(`${s.title} ${s.when_to_apply ?? ''} ${(s.tags ?? []).join(' ')} ${s.principle}`))
    if (!toks.size || !queryTokens.size) return 0
    let hit = 0
    for (const t of toks) if (queryTokens.has(t)) hit++
    return hit / Math.sqrt(toks.size)
  }

  private rank(pool: Skill[], query: Set<string>, k: number, opts: RetrieveOptions): Skill[] {
    const fit = opts.fitness ?? (() => 0.5)
    const random = opts.random ?? Math.random
    const live = pool.filter(s => s.lifecycle !== 'retired')
    const score = (s: Skill) =>
      0.6 * this.relevance(query, s) + 0.4 * fit(s) + (s.lifecycle === 'stable' ? 0.1 : 0)
    const established = live.filter(s => s.lifecycle !== 'trial').sort((a, b) => score(b) - score(a))
    const trials = live.filter(s => s.lifecycle === 'trial')
    const slots = Math.min(opts.exploreSlots ?? 2, trials.length, k)
    const explored = this.sampleTrials(trials, query, slots, random)
    const exploredIds = new Set(explored.map(s => s.skill_id))
    const picked = [...established.slice(0, k - slots), ...explored]
    // established 不够时用剩余 trial 按相关性补齐
    const rest = trials.filter(s => !exploredIds.has(s.skill_id))
      .sort((a, b) => this.relevance(query, b) - this.relevance(query, a))
    for (const s of rest) { if (picked.length >= k) break; picked.push(s) }
    return picked
  }

  /**
   * trial 探索槽的不放回加权采样：权重 = (0.2 + 相关性) / (1 + usage)。
   * 旧实现按 usage 严格升序取前 N，把曝光均匀摊到所有 trial 上——
   * 生产中没有任何技能能积累到晋升阈值；加权采样让「相关且低 usage」的技能更快累积曝光，
   * 同时保留其他 trial 被探索的非零概率。
   */
  private sampleTrials(trials: Skill[], query: Set<string>, n: number, random: () => number): Skill[] {
    const remaining = [...trials]
    const picked: Skill[] = []
    while (picked.length < n && remaining.length > 0) {
      const weights = remaining.map(s =>
        Math.max(1e-6, (0.2 + this.relevance(query, s)) / (1 + (s.usage_count ?? 0))))
      const total = weights.reduce((sum, w) => sum + w, 0)
      let r = random() * total
      let idx = weights.length - 1
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!
        if (r <= 0) { idx = i; break }
      }
      picked.push(remaining.splice(idx, 1)[0]!)
    }
    return picked
  }

  // —— 检索 —— (对应 SkillForge bank.retrieve)
  retrieve(
    userRequest: string,
    topK = 6,
    taskSpecificTopK?: number,
    opts: RetrieveOptions = {},
  ): { general: Skill[]; specific: Skill[]; mistakes: SkillBankData['common_mistakes']; taskType: string } {
    const taskType = this.detectTaskType(userRequest)
    const q = new Set(tokenize(userRequest))
    const general = this.rank(this.data.general_skills, q, topK, opts)
    const specificPool = this.data.task_specific_skills[taskType] ?? []
    const specific = this.rank(specificPool, q, taskSpecificTopK ?? specificPool.length, opts)
    return { general, specific, mistakes: this.data.common_mistakes.slice(0, 5), taskType }
  }

  // —— Prompt 渲染 ——
  formatPrompt(retrieved: ReturnType<SkillBank['retrieve']>): string {
    const sections: string[] = []
    if (retrieved.general.length) {
      sections.push(
        '### General Principles\n' +
        retrieved.general.map(s =>
          `- **${s.title}**: ${s.principle}`
        ).join('\n')
      )
    }
    if (retrieved.specific.length) {
      const title = retrieved.taskType.replace(/_/g, ' ')
      sections.push(
        `### ${title} Skills\n` +
        retrieved.specific.map(s => {
          let line = `- **${s.title}**: ${s.principle}`
          if (s.when_to_apply) line += `\n  _Apply when: ${s.when_to_apply}_`
          return line
        }).join('\n')
      )
    }
    if (retrieved.mistakes.length) {
      sections.push(
        '### Mistakes to Avoid\n' +
        retrieved.mistakes.map(m =>
          `- **Don't**: ${m.description}\n  **Instead**: ${m.how_to_avoid}`
        ).join('\n')
      )
    }
    return sections.join('\n\n') || 'No relevant skills found.'
  }

  // —— 信用分配（对应 SkillForge bank.record_episode）——
  recordEpisode(
    skills: Skill[],
    success: boolean,
    context?: { task?: string; trajectory?: string },
  ): void {
    for (const skill of skills) {
      this.ensureFields(skill)
      skill.usage_count += 1
      if (success) skill.success_count += 1
      if (!success && context?.task) {
        skill.recent_failures.push({
          task: (context.task ?? '').slice(0, 500),
          trajectory: (context.trajectory ?? '').slice(0, 1000),
        })
        // 只保留最近 15 条
        if (skill.recent_failures.length > 15) {
          skill.recent_failures = skill.recent_failures.slice(-15)
        }
      }
      skill.updatedAt = new Date().toISOString()
    }
  }

  /**
   * 蒸馏器再次提取出等价技能 = 该经验跨会话反复出现的信号。
   * 记为一次成功使用：旧行为是直接丢弃重复提取，信号随之丢失，
   * 导致反复出现的经验也永远到不了晋升阈值。
   */
  reinforce(skill: Skill): void {
    if (skill.lifecycle === 'retired') return
    this.ensureFields(skill)
    skill.usage_count += 1
    skill.success_count += 1
    skill.updatedAt = new Date().toISOString()
  }

  // —— 添加新 skill ——
  add(skill: Skill, category = 'general'): boolean {
    if (!skill.skill_id || this.skillIds().has(skill.skill_id)) return false
    this.ensureFields(skill, 'trial')
    skill.lifecycle = 'trial'
    if (category === 'general') {
      this.data.general_skills.push(skill)
    } else {
      if (!this.data.task_specific_skills[category]) {
        this.data.task_specific_skills[category] = []
      }
      this.data.task_specific_skills[category].push(skill)
    }
    return true
  }

  // —— 移除 skill ——
  remove(skillId: string): boolean {
    let removed = false
    const origLen = this.data.general_skills.length
    this.data.general_skills = this.data.general_skills.filter(s => s.skill_id !== skillId)
    if (this.data.general_skills.length < origLen) removed = true

    for (const [group, skills] of Object.entries(this.data.task_specific_skills)) {
      const before = skills.length
      this.data.task_specific_skills[group] = skills.filter(s => s.skill_id !== skillId)
      if (this.data.task_specific_skills[group].length < before) removed = true
    }
    if (removed) this.detachLineage(skillId)
    return removed
  }

  // —— 软淘汰：标记 retired 而非删除 ——
  // 记录保留在库中，findNearDuplicate 据此拦截「同一差技能被蒸馏器反复重新学习」的churn；
  // 检索/进化均只看存活技能（allSkills 默认排除 retired），行为与删除一致
  retire(skillId: string): boolean {
    const skill = this.getSkill(skillId)
    if (!skill || skill.lifecycle === 'retired') return false
    skill.lifecycle = 'retired'
    skill.updatedAt = new Date().toISOString()
    this.pruneRetired()
    return true
  }

  /** retired 墓碑超限时丢弃最旧的，并摘除其对谱系的引用 */
  private pruneRetired(): void {
    const retired = this.allSkills(true).filter(s => s.lifecycle === 'retired')
    if (retired.length <= MAX_RETIRED_SKILLS) return
    const drop = new Set(retired
      .sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''))
      .slice(0, retired.length - MAX_RETIRED_SKILLS)
      .map(s => s.skill_id))
    this.data.general_skills = this.data.general_skills.filter(s => !drop.has(s.skill_id))
    for (const group of Object.keys(this.data.task_specific_skills)) {
      this.data.task_specific_skills[group] = this.data.task_specific_skills[group].filter(s => !drop.has(s.skill_id))
    }
    for (const id of drop) this.detachLineage(id)
  }

  /** 硬删除后谱系会留下悬空引用：父的 children 移除该 ID，其子技能的 parent_id 置空 */
  private detachLineage(skillId: string): void {
    for (const s of this.allSkills(true)) {
      if (s.children?.length) s.children = s.children.filter(id => id !== skillId)
      if (s.parent_id === skillId) s.parent_id = null
    }
  }

  // —— 查询 skill 所属分类（变异子技能继承父技能的任务分组） ——
  categoryOf(skillId: string): string {
    if (this.data.general_skills.some(s => s.skill_id === skillId)) return 'general'
    for (const [group, skills] of Object.entries(this.data.task_specific_skills)) {
      if (skills.some(s => s.skill_id === skillId)) return group
    }
    return 'general'
  }

  // —— 统计 ——
  counts(): { general: number; taskSpecific: number; retired: number; total: number } {
    const live = (arr: Skill[]) => arr.filter(s => s.lifecycle !== 'retired').length
    return {
      general: live(this.data.general_skills),
      taskSpecific: Object.values(this.data.task_specific_skills).reduce((sum, arr) => sum + live(arr), 0),
      retired: this.allSkills(true).length - this.size,
      total: this.size,
    }
  }
}
