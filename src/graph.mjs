/**
 * 图谱：把孤立的记忆连起来。
 *
 * 为什么需要：语义检索只能找到「像」的，找不到「相关」的。
 * 问「那天还发生了什么」，需要的是「同一天」的边，不是语义相似。
 *
 * 三种边：
 *   same_source  同一轮对话提炼出来的（最紧）
 *   same_day     同一天发生的事（按时间差给权重）
 *   similar      语义高度相似（同一件事的不同说法）
 *
 * 边也会衰减：每天乘一个系数，被走到就回一点血。
 * 不衰减的话，早期的边会永远占着图。
 */
import { loadConfig } from './config.mjs'
import { cosine, blobToVec } from './scoring.mjs'

const DAY = 86400000

/** 确保 link 表有 kind 和 time 字段（老库可能只有 a/b/weight） */
export function ensureLinkSchema(db) {
  db.exec(`
    create table if not exists link (
      a text, b text, weight real, kind text, time integer,
      primary key (a, b)
    )
  `)
  try { db.exec('alter table link add column kind text') } catch { /* 已有 */ }
  try { db.exec('alter table link add column time integer') } catch { /* 已有 */ }
}

/** 无向边统一存成 (小 id, 大 id)，避免重复 */
function putEdge(db, a, b, weight, kind, now) {
  if (a === b) return
  const [x, y] = a < b ? [a, b] : [b, a]
  db.prepare(`
    insert into link (a, b, weight, kind, time) values (?,?,?,?,?)
    on conflict(a, b) do update set
      weight = max(link.weight, excluded.weight),
      kind = excluded.kind,
      time = excluded.time
  `).run(x, y, weight, kind, now)
}

/**
 * 建边：扫一遍所有活跃记忆，按三种规则连。
 *
 * 复杂度：同一天用分桶（O(n)），相似用向量比对（O(n²)）。
 * 记忆上千条时向量那部分会慢，所以有 skipSimilar 开关。
 */
export function buildEdges(db, opts = {}) {
  const cfg = opts.cfg || loadConfig()
  const now = opts.now || Date.now()
  const skipSimilar = opts.skipSimilar === true
  const similarThreshold = opts.similarThreshold ?? 0.78

  ensureLinkSchema(db)

  const mems = db.prepare(
    "select id, at, created, source_mid, vec from mem where status = 'active' and archived = 0"
  ).all()

  let edges = 0

  // 1) 同一轮对话（最强）
  const bySource = new Map()
  for (const m of mems) {
    if (!m.source_mid) continue
    if (!bySource.has(m.source_mid)) bySource.set(m.source_mid, [])
    bySource.get(m.source_mid).push(m.id)
  }
  for (const ids of bySource.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        putEdge(db, ids[i], ids[j], 0.95, 'same_source', now)
        edges++
      }
    }
  }

  // 2) 同一天：按日期分桶，桶内两两连（时间越近权重越高）
  const byDay = new Map()
  for (const m of mems) {
    const t = m.at || m.created
    if (!t) continue
    const day = new Date(t).toISOString().slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push({ id: m.id, t })
  }
  for (const bucket of byDay.values()) {
    if (bucket.length > 60) continue   // 一天几百条就不两两连了，没有意义
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const dt = Math.abs(bucket[i].t - bucket[j].t) / 3600000   // 小时
        // 同一小时内 0.7，隔 12 小时降到 0.42
        const w = Math.max(0.3, 0.7 - dt * 0.023)
        putEdge(db, bucket[i].id, bucket[j].id, +w.toFixed(3), 'same_day', now)
        edges++
      }
    }
  }

  // 3) 语义相似：同一件事的不同说法
  if (!skipSimilar) {
    const withVec = mems
      .map((m) => ({ id: m.id, v: blobToVec(m.vec) }))
      .filter((x) => x.v)
    // 超过 800 条就只比一部分，避免 O(n²) 卡死
    const pool = withVec.length > 800 ? withVec.slice(0, 800) : withVec
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const c = cosine(pool[i].v, pool[j].v)
        if (c < similarThreshold) continue
        putEdge(db, pool[i].id, pool[j].id, +(c * 0.9).toFixed(3), 'similar', now)
        edges++
      }
    }
  }

  // 4) 老的边整体衰减一点（有走向就有淡化，模拟"不联系就疏远"）
  db.prepare('update link set weight = weight * 0.98 where time < ?').run(now - DAY)

  return {
    ok: true,
    memories: mems.length,
    edges,
    total: db.prepare('select count(*) c from link').get().c,
  }
}

/** 取一条记忆的邻居（带权重） */
export function neighbors(db, id, limit = 20) {
  ensureLinkSchema(db)
  return db.prepare(`
    select case when a = ? then b else a end as id, weight, kind
    from link where a = ? or b = ?
    order by weight desc limit ?
  `).all(id, id, id, limit)
}

/**
 * 图中心度：一条记忆连了多少条、连着谁有多重。
 * 用来给检索打分加一点「它在不在网里」的分量。
 */
export function degreeMap(db) {
  ensureLinkSchema(db)
  const out = new Map()
  for (const r of db.prepare('select a, b, weight from link').all()) {
    out.set(r.a, (out.get(r.a) || 0) + r.weight)
    out.set(r.b, (out.get(r.b) || 0) + r.weight)
  }
  return out
}

/**
 * 沿边扩散：从几条种子出发，找一步之遥的相关记忆。
 * 用于回答「那天还发生了什么」这类问题。
 */
export function spread(db, seedIds, opts = {}) {
  ensureLinkSchema(db)
  const limit = opts.limit ?? 10
  const decay = opts.decay ?? 0.5
  const score = new Map()
  for (const id of seedIds) {
    for (const n of neighbors(db, id, 30)) {
      if (seedIds.includes(n.id)) continue
      score.set(n.id, Math.max(score.get(n.id) || 0, n.weight * decay))
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  return ranked.map(([id, weight]) => {
    const m = db.prepare('select id, text, kind from mem where id = ?').get(id)
    return m ? { ...m, graphWeight: +weight.toFixed(2) } : null
  }).filter(Boolean)
}
