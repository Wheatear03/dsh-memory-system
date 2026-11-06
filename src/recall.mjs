/**
 * 检索：一句话进来，挑几条最相关的记忆出去。
 *
 * 流程：
 *   候选池 → 两路线索（字面 + 语义）→ RRF 融合 → 加权打分 → 过滤 → 取前 N
 *
 * 每道过滤都有原因，写在对应的注释里。
 */
import { loadConfig } from './config.mjs'
import {
  grams, retrievability, rrfFuse, blobToVec,
} from './scoring.mjs'
import { listCandidates, makeResolver, logRecall } from './storage.mjs'
import { degreeMap } from './graph.mjs'

/** 调 embedding 服务（本地 bge-m3 或任意 OpenAI 兼容接口） */
export async function embed(text, cfg = loadConfig()) {
  const e = cfg.embedding
  const url = e.baseUrl.replace(/\/+$/, '') + '/v1/embeddings'
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(e.apiKey ? { Authorization: 'Bearer ' + e.apiKey } : {}),
      },
      body: JSON.stringify({ model: e.model, input: [String(text).slice(0, 400)] }),
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) return null
    const j = await r.json()
    const v = j.data?.[0]?.embedding
    return v ? new Float32Array(v) : null
  } catch {
    // 向量服务挂了不是世界末日：字面线索还能用，只是变笨一点
    return null
  }
}

/**
 * 检索。
 *
 * @param {object} db   已打开的数据库
 * @param {string} query 用户这句话
 * @param {object} opts  { mode, limit, cfg }
 * @returns {Promise<{ hits: Array, took: number, degraded: boolean }>}
 */
export async function recall(db, query, opts = {}) {
  const cfg = opts.cfg || loadConfig()
  const q = String(query || '').trim()
  const t0 = Date.now()
  if (q.length < 3) return { hits: [], took: 0, degraded: false }

  const mode = opts.mode || 'work'   // work = 少而准；review = 广而全
  const limit = opts.limit ?? (mode === 'review' ? 10 : cfg.recall.maxItems)

  const qg = grams(q)
  const qvec = await embed(q, cfg)

  const candidates = listCandidates(db)
  if (!candidates.length) return { hits: [], took: Date.now() - t0, degraded: !qvec }

  // 1) 两路线索
  const now = Date.now()
  const withCue = candidates.map((m) => {
    const d = retrievability(m, qg, now, qvec, cfg)
    return {
      m,
      kw: d.kwCue,
      sem: d.semCue,
      R: d.R,
      decay: { S: d.S, D: d.D, E: d.E, C: d.C },
    }
  })

  // 图中心度：连得越多说明它在网里，给一点加成（不是主因，只是"相关但不相似"的补偿）
  const degrees = degreeMap(db)
  const maxDeg = Math.max(1, ...degrees.values())

  // 2) RRF 融合两路名次（尺度无关，比加权平均稳）
  const fused = rrfFuse(withCue, !!qvec)

  // 3) 用融合后的 cue 重算 R
  const scored = withCue
    .map((x) => {
      const d = retrievability(x.m, qg, now, qvec, cfg, fused.get(x.m.id) ?? 0)
      return { ...x, R: d.R, cue: d.cue }
    })
    // 线索太弱的不要：RRF 只看名次不看差距，不卡这条会混进无关条目
    .filter((x) => x.cue >= cfg.recall.minCue)
    // 置信度过低的不要：验证判过问题的，召回也是噪音
    .filter((x) => (x.m.confidence ?? 0.7) >= cfg.recall.minConfidence)
    // 有出处的优先：能查到原话的，比查不到的更值得信
    .map((x) => {
      const w = x.m.source === 'manual' ? 1.0
        : x.m.source === 'llm_extracted' ? 0.96
          : 0.86
      return { ...x, R: x.R * w }
    })
    .sort((a, b) => b.R - a.R)

  // 3.5) 图加成：只在「跟头名差不到 4%」时用来打破平手。
  // 差得多的说明本来就不相关，连多少边都不该把它救回来（否则旧内容会盖掉新答案）。
  const maxR0 = Math.max(0.0001, ...scored.map((y) => y.R))
  const graphRanked = scored.map((x) => {
    if (x.R < maxR0 * 0.96) return x
    const g = 1 + 0.15 * Math.min(1, (degrees.get(x.m.id) || 0) / maxDeg)
    return { ...x, R: x.R * g, graph: g }
  }).sort((a, b) => b.R - a.R)

  // 4) 墓碑解析：命中旧版本时顺着指针找到现任
  const resolve = makeResolver(db)
  const best = new Map()
  for (const x of graphRanked) {
    if (x.m.status === 'superseded' || x.m.status === 'fused') continue  // 干活模式不要旧说法
    const targetId = resolve(x.m.id)
    const target = targetId === x.m.id ? x.m : db.prepare('select * from mem where id = ?').get(targetId)
    if (!target) continue
    const cur = best.get(targetId)
    if (!cur || x.R > cur.R) best.set(targetId, { ...x, m: target })
  }

  const ranked = [...best.values()].sort((a, b) => b.R - a.R)

  // 5) 预算：条数 + 总字数双限制
  //    防止某一轮突然塞一大段进来把上下文撑爆
  const hits = []
  let chars = 0
  for (const x of ranked) {
    const cost = String(x.m.text).length
    if (hits.length >= limit) break
    if (chars + cost > cfg.recall.maxChars) continue
    hits.push({
      id: x.m.id,
      text: String(x.m.text),
      kind: x.m.kind,
      owner: x.m.owner,
      sourceMid: x.m.source_mid,
      confidence: x.m.confidence,
      R: +x.R.toFixed(3),
    })
    chars += cost
  }

  logRecall(db, q, hits.map((h) => h.id))
  return { hits, took: Date.now() - t0, degraded: !qvec }
}

/** 把检索结果拼成给模型看的文本 */
export function formatForPrompt(hits, cfg = loadConfig()) {
  if (!hits.length) return ''
  const lines = hits.map((h, i) => {
    const tag = h.kind && h.kind !== 'fact' ? `[${h.kind}] ` : ''
    return `${i + 1}. ${tag}${h.text}`
  })
  return '【记忆】\n' + lines.join('\n')
}
