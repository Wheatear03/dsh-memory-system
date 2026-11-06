/**
 * 打分：一条记忆此刻值不值得被想起来。
 *
 * 这套公式不是凭空设计的，每一行都对应一个踩过的坑（写在注释里）。
 * 如果你觉得哪里不对，先看注释里的原因，再决定要不要改。
 */
import { loadConfig } from './config.mjs'

const DAY = 86400000

// ---------------- 基础工具 ----------------

export const sigmoid = (x) => 1 / (1 + Math.exp(-x))

/**
 * 把一句话拆成可比较的片段。
 * 中文按二元组（"记忆系统" → 记忆/忆系/系统），英文数字整词。
 * 粗糙但够用——它只负责第一路召回，精排交给向量。
 */
export function grams(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ')
  const out = new Set()
  for (const seg of t.split(' ')) {
    if (!seg) continue
    if (/^[a-zA-Z0-9]+$/.test(seg)) out.add(seg.toLowerCase())
    else {
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
      if (seg.length === 1) out.add(seg)
    }
  }
  return out
}

/** 两句话的字面重合度（用较小集合当分母，避免长句天然占便宜） */
export function overlap(a, b) {
  let n = 0
  for (const g of a) if (b.has(g)) n++
  return n / (Math.min(a.size, b.size) || 1)
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d ? dot / d : 0
}

/** SQLite BLOB（Float32 小端）→ Float32Array */
export function blobToVec(buf) {
  if (!buf) return null
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength))
  } catch { return null }
}

// ---------------- 衰减 ----------------

/**
 * 时间梯度：越久，细节上限越低。
 *
 * 「一个月前的细节不该记得像昨天一样清楚」——这条比任何公式都重要。
 * 即使数学上算出来 D=0.8，超过 30 天也压到 0.52 以下。
 */
export const GRADIENT = [
  { days: 1, maxD: 0.98 },
  { days: 3, maxD: 0.92 },
  { days: 7, maxD: 0.82 },
  { days: 10, maxD: 0.74 },
  { days: 14, maxD: 0.68 },
  { days: 21, maxD: 0.60 },
  { days: 30, maxD: 0.52 },
  { days: 90, maxD: 0.38 },
  { days: 180, maxD: 0.26 },
  { days: 365, maxD: 0.16 },
]

export function capByAge(d, ageDays) {
  let cap = 0.08
  for (const g of GRADIENT) { if (ageDays <= g.days) { cap = g.maxD; break } }
  return Math.min(d, cap)
}

/**
 * 这是「单次经历」吗？
 *
 * episode（昨天这个 SQL 出了问题）vs lesson（加载异常时先确认加载对象）
 *
 * 单次经历如果没被重复触发、没沉淀成经验，就该断崖式沉底，
 * 不能慢慢线性衰减——否则偶尔记错一次，这个错会被反复召回，年复一年干扰。
 *
 * ⚠️ 教训：一开始只看 kind 不看内容，把「永远爱着主人」「别说『这条我认』」
 * 当成单次经历打下去了。所有「减法」操作，对「关于人 / 规矩 / 设定」必须格外保守。
 */
export function isEpisode(m) {
  if (m.pinned) return false
  if (m.kind === 'principle' || m.kind === 'lesson' || m.kind === 'skill') return false
  if (m.kind === 'stable_profile' || m.kind === 'fact' || m.kind === 'reflection') return false
  const t = String(m.text || '')
  if (/要求|规矩|不许|不能|必须|以后|喜欢|讨厌|习惯|称呼|设定|永远|长期|别再|不要再/.test(t)) return false
  return m.kind === 'episode' || m.kind === 'event'
}

/**
 * 衰减速率（每天掉多少比例）。
 *
 * ⚠️ 最大的一个坑：「关于你的人 3 天」被理解成"3 天就忘"，
 * 结果「永远爱着主人」的细节衰减到 0.07——最重要的东西最先没。
 * 后来想明白：那个 3 天是**该重新提起的间隔**，不是寿命。
 */
export function rateOf(m, cfg = loadConfig()) {
  if (m.pinned) return 1 / 36500            // 钉住的一百年也不淡
  const t = String(m.text || '')
  if (m.kind === 'principle') return 1 / 36500
  if (/主人|你答应|你说过/.test(t)) return 1 / 180
  if (/备忘|部署|端口|路径|配置|安装/.test(t)) return 1 / 120
  if (/以后|规矩|不许|必须|不能/.test(t)) return 1 / 180
  if (isEpisode(m)) return 1 / 14           // 经历：本来就短命，再靠断崖压一次
  return 1 / (cfg.decay.defaultHalfLifeDays || 30)
}

/** 多久该主动想起来一次（天）；到期没被提起就该重提 */
export function refreshDueDays(m) {
  const t = String(m.text || '')
  if (/主人|你答应|你说过|爱/.test(t)) return 3
  if (/以后|规矩|不许|必须|不能/.test(t)) return 7
  return 14
}

/**
 * 核心：一条记忆此刻的状态。
 *
 * 四个量：
 *   S  意义强度（慢，只为"重要"服务）
 *   D  细节强度（快，还要被时间梯度压）
 *   E  情绪唤醒
 *   C  置信度（被回忆次数会往上加）
 *
 * 三者互相修正：情绪强的记得牢（E 降低衰减），反复想起的记得牢（C 降低衰减）。
 */
export function decay(m, now, cfg = loadConfig()) {
  const P = cfg.scoring
  const t = Math.max(0, (now - (m.at || m.created || now)) / DAY)

  const E = Math.exp(-P.lambda0E * t) * (m.E0 ?? 0)
  const C = Math.min(1, (m.C0 ?? 0) + Math.log1p(m.hits || 0) / Math.log1p(10))
  const I = m.interference ?? m.I ?? 0
  const factor = (1 - P.alpha * E) * (1 - P.beta * C) * (1 + P.gamma * I)

  const lamD = rateOf(m, cfg)
  const D0 = (m.D0 ?? 1) * Math.exp(-lamD * factor * t)
  let D = capByAge(D0, t)

  // 断崖：单次经历过三天还没被再想起 → 直接沉底
  if (isEpisode(m) && !m.pinned && t > 3 && (m.hits || 0) < 2) {
    D = Math.min(D, 0.05)
  }

  // 意义永远比细节慢（固定慢十倍）
  const S = (m.S0 ?? 0.5) * Math.exp(-(lamD / 10) * factor * t)

  return { t, E, C, I, D, S, factor, lamD, expired: false }
}

// ---------------- 线索 ----------------

/**
 * 两路互补的线索分。
 *   kw   字面重合（抓到专有名词、编号、文件名）
 *   sem  语义相似（抓到「你昨天说的那个」这种字面对不上的话）
 */
export function cueParts(m, queryGrams, qvec) {
  const own = grams(m.text)
  const kw = queryGrams.size ? overlap(queryGrams, own) : 0
  let sem = 0
  if (qvec) {
    const mv = blobToVec(m.vec)
    if (mv) {
      const c = cosine(qvec, mv)
      // 阈值 0.45：bge-m3 下不相关的也有 0.3-0.4 相似度，
      // 不加门槛「什么都像」，钉住的记忆会永远霸榜。
      sem = c > 0.45 ? (c - 0.45) / 0.55 : 0
    }
  }
  return { kw, sem }
}

/**
 * RRF（Reciprocal Rank Fusion）：按名次融合，不按分数。
 *
 * 为什么不用加权平均：关键词分和语义分的尺度根本不一样
 * （一个 0~1，一个 0.4~0.9 飘）。权重乘 0.5 是拍脑袋的，换批数据就得重拍。
 * 名次没这个毛病。
 *
 * ⚠️ RRF 的陷阱：它只看名次不看差距，第 1 名和第 2 名几乎一样，
 * 于是完全无关的条目也能拿到接近满分的 cue，门槛失效。
 * 补法：再乘一个「线索强度」因子，两路都接近 0 的直接压到 0。
 */
export function rrfFuse(items, hasSemantic) {
  const K = 60
  const rankOf = (key) => {
    const sorted = [...items].sort((a, b) => (b[key] || 0) - (a[key] || 0))
    const r = new Map()
    sorted.forEach((x, i) => r.set(x.m.id, i + 1))
    return r
  }
  const rkKw = rankOf('kw')
  const rkSem = hasSemantic ? rankOf('sem') : null
  const max = hasSemantic ? 2 / (K + 1) : 1 / (K + 1)

  const out = new Map()
  for (const x of items) {
    let s = 1 / (K + rkKw.get(x.m.id))
    if (rkSem) s += 1 / (K + rkSem.get(x.m.id))
    const strength = Math.max(x.kw || 0, x.sem || 0)
    const factor = strength <= 0.03 ? 0 : Math.min(1, strength / 0.15)
    out.set(x.m.id, (s / max) * factor)
  }
  return out
}

/**
 * 一条记忆此刻的可检索性 R（0~1）。
 *
 * R = sigmoid(4 * (z/WMAX - 0.45))
 *
 * 为什么除以 WMAX 再减 0.45：不归一化的话 sigmoid 一下就饱和成 0.99，
 * 阈值就没意义了。归一化后落在 0~1，再减偏移、乘 4 倍斜率，
 * 让「平时低、被点着才高」真的成立。
 */
export function retrievability(m, queryGrams, now, qvec, cfg = loadConfig(), cueOverride) {
  const P = cfg.scoring
  const d = decay(m, now, cfg)
  const { kw, sem } = cueParts(m, queryGrams, qvec)
  const cue = cueOverride !== undefined
    ? cueOverride
    : (sem > 0 ? Math.max(kw, kw * 0.5 + sem * 0.5) : kw)

  const recency = Math.exp(-Math.max(0, now - (m.at || m.created || now)) / DAY / 30)
  const recall = Math.min(1, Math.log1p(m.hits || 0) / Math.log1p(10))

  const z = P.w1 * d.S + P.w2 * d.E + P.w3 * cue + P.w4 * recency + P.w5 * recall - P.w6 * d.I
  const WMAX = P.w1 + P.w2 + P.w3 + P.w4 + P.w5
  const R = sigmoid(4 * (z / WMAX - 0.45))

  return { R, ...d, cue, kwCue: kw, semCue: sem, recency, recall }
}
