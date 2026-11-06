/**
 * 验证：回原文核对，抓「记反」和「脑补」。
 *
 * 为什么必须有这一步：
 *   模型提炼时会顺手"补全"——把 v17 记成 v14、把没说的话编成"他说的"。
 *   这些错误在记忆里完全看不出来，只有回原文比对才抓得到。
 *
 * 处理方式很克制：
 *   ok           → verified=1，置信度不动
 *   distorted    → 置信度压到 0.25，退出召回
 *   unsupported  → 置信度压到 0.4，退出召回
 * 不删除。万一验证本身判错了，还能改回来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, PROJECT_ROOT } from './config.mjs'

const PROMPT_FILE = path.join(PROJECT_ROOT, 'prompts', 'verify.txt')

const VERDICT_TO_CONFIDENCE = {
  ok: null,          // 不改
  distorted: 0.25,
  unsupported: 0.4,
}

async function ask(system, user, cfg) {
  const l = cfg.llm
  const url = l.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(l.apiKey ? { Authorization: 'Bearer ' + l.apiKey } : {}),
    },
    body: JSON.stringify({
      model: l.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,   // 判真伪不该有随机性
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  return j.choices?.[0]?.message?.content || '[]'
}

function parseVerdicts(raw) {
  const s = String(raw || '').indexOf('[')
  const e = String(raw || '').lastIndexOf(']')
  if (s < 0 || e <= s) return []
  try {
    const arr = JSON.parse(String(raw).slice(s, e + 1))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * 验证一批记忆。
 *
 * @param {Array<{text: string, sourceUser: string, sourceAssistant: string}>} items
 * @param {object} opts { cfg, batchSize }
 * @returns {Promise<Array<{index: number, verdict: string, why: string, confidence: number|null}>>}
 */
export async function verify(items, opts = {}) {
  const cfg = opts.cfg || loadConfig()
  const batchSize = opts.batchSize || 8
  const system = fs.readFileSync(PROMPT_FILE, 'utf8')
  const results = []

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const body = batch.map((x, k) =>
      `【${k + 1}】\n记忆：${x.text}\n原话-你说：${x.sourceUser || '(无)'}\n原话-我回：${x.sourceAssistant || '(无)'}`
    ).join('\n\n')

    let verdicts = []
    try {
      verdicts = parseVerdicts(await ask(system, body, cfg))
    } catch {
      // 这一批没验成功，保持原状（宁可没验，也不要误判）
      continue
    }

    for (const v of verdicts) {
      const idx = Number(v.i) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue
      const verdict = String(v.v || '')
      if (!(verdict in VERDICT_TO_CONFIDENCE)) continue
      results.push({
        index: i + idx,
        verdict,
        why: String(v.why || '').slice(0, 40),
        confidence: VERDICT_TO_CONFIDENCE[verdict],
      })
    }
  }

  return results
}
