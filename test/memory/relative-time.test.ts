import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRelativeTime } from '../../src/memory/graph-ids.js'

/**
 * P1 修复验证：相对时间解析的星期感知。
 * 基准事实（日历已核对）：2026-10-25 是周日；周一起算的"上周"= 10-12(一)…10-18(日)，其中周三 = 10-14。
 * 旧实现把"上周三"当作 today−7 解析成 2026-10-18（周日），与对话中使用的 10-14 矛盾。
 */
describe('resolveRelativeTime 相对时间解析', () => {
  it('“上周X”：按周一起算取上一周的对应星期几', () => {
    assert.equal(resolveRelativeTime('上周三', '2026-10-25'), '2026-10-14')   // 周日说上周三 → 10-14，不再是 10-18
    assert.equal(resolveRelativeTime('上星期三', '2026-10-25'), '2026-10-14')
    assert.equal(resolveRelativeTime('上周三', '2026-10-21'), '2026-10-14')   // 周三说上周三同样是 10-14
    assert.equal(resolveRelativeTime('上周五', '2026-10-25'), '2026-10-16')
    assert.equal(resolveRelativeTime('上周日', '2026-10-25'), '2026-10-18')
    assert.equal(resolveRelativeTime('上礼拜三', '2026-10-25'), '2026-10-14')
  })

  it('“本周X / 这周X / 下周X”', () => {
    assert.equal(resolveRelativeTime('本周三', '2026-10-25'), '2026-10-21')
    assert.equal(resolveRelativeTime('这周五', '2026-10-25'), '2026-10-23')
    assert.equal(resolveRelativeTime('下周三', '2026-10-25'), '2026-10-28')
  })

  it('英文 last/this/next + weekday', () => {
    assert.equal(resolveRelativeTime('last wednesday', '2026-10-25'), '2026-10-14')
    assert.equal(resolveRelativeTime('Last Wed', '2026-10-25'), '2026-10-14')
    assert.equal(resolveRelativeTime('this friday', '2026-10-25'), '2026-10-23')
    assert.equal(resolveRelativeTime('next monday', '2026-10-25'), '2026-10-26')
  })

  it('裸“上周”仍是 today−7（周一起算下必然落在上一周内）', () => {
    assert.equal(resolveRelativeTime('上周', '2026-10-25'), '2026-10-18')
    assert.equal(resolveRelativeTime('last week', '2026-10-25'), '2026-10-18')
  })

  it('“上个月”按日历月取同一天，月末钳制到月末', () => {
    assert.equal(resolveRelativeTime('上个月', '2026-10-25'), '2026-09-25')
    assert.equal(resolveRelativeTime('上个月', '2026-10-31'), '2026-09-30')   // 旧实现 ago(30) 会给 10-01
    assert.equal(resolveRelativeTime('上个月', '2026-03-31'), '2026-02-28')
    assert.equal(resolveRelativeTime('last month', '2026-10-25'), '2026-09-25')
  })

  it('既有行为回归：绝对日期直通、今天/昨天、N天前、模糊时间保持 undefined', () => {
    assert.equal(resolveRelativeTime('2026-09-01', '2026-10-25'), '2026-09-01')
    assert.equal(resolveRelativeTime('2026-09', '2026-10-25'), '2026-09')
    assert.equal(resolveRelativeTime('今天', '2026-10-25'), '2026-10-25')
    assert.equal(resolveRelativeTime('昨天', '2026-10-25'), '2026-10-24')
    assert.equal(resolveRelativeTime('3天前', '2026-10-25'), '2026-10-22')
    assert.equal(resolveRelativeTime('2 weeks ago', '2026-10-25'), '2026-10-11')
    assert.equal(resolveRelativeTime('最近', '2026-10-25'), undefined)          // 模糊时间不猜，保留原文
    assert.equal(resolveRelativeTime('recently', '2026-10-25'), undefined)
    assert.equal(resolveRelativeTime('星期三', '2026-10-25'), undefined)        // 无上/这/下前缀，歧义保留原文
    assert.equal(resolveRelativeTime(undefined, '2026-10-25'), undefined)
  })
})
