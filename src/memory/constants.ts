// ---- 保留原有 ----
export const TIER_POLICIES = {
  // episodic 和 semantic 的策略现在由 GraphStore 管理
  procedural: {
    maxEntries: 30,
    maxTotalChars: 60_000,
    decayDays: 180,
    hardDeleteDays: null,
  },
} as const

export const MEMORY_CONTEXT_BUDGET = {
  maxInjectionChars: 4_000,
  reservedUtilization: 0.05,
} as const

export const SKILL_BANK_CONFIG = {
  defaultBankFileName: 'skill-bank.json',
  maxGeneralSkills: 30,
  maxTaskSpecificPerGroup: 20,
  maxCommonMistakes: 10,
  retrieveTopK: 6,
  /** 增量蒸馏间隔（回合），可被 MINI_CODE_SKILL_DISTILL_EVERY 覆盖 */
  distillEvery: 3,
  /** 增量蒸馏的最小新增消息数：太薄的 delta 先攒一攒，不值得一次模型调用 */
  distillMinDeltaMessages: 3,
  /** trial 占存活技能比例达到此值时暂停新增蒸馏，让存量 trial 先积累 usage 进化 */
  distillMaxTrialRatio: 0.6,
  /** trial 数量低于此值时不触发比例暂停（小池子照常蒸馏） */
  distillMinTrialsForPause: 8,
  /** 技能池用量超过容量上限的此比例时暂停蒸馏 */
  distillNearCapacityRatio: 0.9,
} as const

// ---- 新增 ----
export const COGMEM_CONFIG = {
  /** SearchAgent 最大迭代次数 */
  searchMaxIterations: 4,
  /** 向量检索默认 topK */
  semanticSearchTopK: 10,
  /** 锚点检索默认 topK */
  findAnchorsTopK: 5,
  /** 图遍历默认深度 */
  traverseMaxDepth: 1,
  /** 图遍历默认最大结果数 */
  traverseMaxResults: 10,
  /** 记忆巩固最小 Event 数阈值 */
  consolidationMinEvents: 3,
  /** 注入 prompt 的最大节点数 */
  maxInjectedNodes: 8,
} as const
