/**
 * 提炼：从对话里挑出值得长期记住的内容。
 *
 * 规则式的办法试过了，捞不到东西——"值得记"这件事没法用正则表达。
 * 所以这里用模型判断，但加了三道保险：
 *   1. 提示词单独放 prompts/extract.txt，想改行为改文本就行
 *   2. 强制要求 src（来源轮次）：说不出从哪看来的，这条就不要
 *   3. 提炼完还要过 verify 回原文核对（见 verify.mjs）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, PROJECT_ROOT } from './config.mjs'

const PROMPT_FILE = path.join(PROJECT_ROOT, 'prompts', 'extract.txt')

function loadPrompt() {
  try {
    return fs.readFileSync(PROMPT_FILE, 'utf8')
  } catch {
    throw new Error('找不到提示词文件: ' + PROMPT_FILE)
  }
}

/** 调 OpenAI 兼容的 chat 接口 */
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
      temperature: 0.2,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  return j.choices?.[0]?.message?.content || '[]'
}

/** 从模型输出里抠出 JSON 数组（它经常包解释文字或 ```json 围栏） */
export function parseJsonArray(raw) {
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
 * 提炼一批对话。
 *
 * @param {Array<{user: string, assistant: string}>} turns  一段对话
 * @param {object} opts  { cfg, batchSize, existing }
 * @returns {Promise<Array>}  记忆条目（还没入库）
 */
export async function extract(turns, opts = {}) {
  const cfg = opts.cfg || loadConfig()
  const batchSize = opts.batchSize || 12
  const existing = new Set(opts.existing || [])   // 已存在的记忆（前 30 字归一后）

  const system = loadPrompt()
  const out = []

  for (let i = 0; i < turns.length; i += batchSize) {
    const chunk = turns.slice(i, i + batchSize)
    const dialog = chunk.map((t, k) => {
      const u = String(t.user || '').replace(/\s+/g, ' ').slice(0, 300)
      const a = String(t.assistant || '').replace(/\s+/g, ' ').slice(0, 200)
      return `【${k + 1}】用户：${u}\n我：${a}`
    }).join('\n\n')

    if (!dialog.trim()) continue

    let items = []
    try {
      items = parseJsonArray(await ask(system, dialog, cfg))
    } catch (e) {
      // 一批失败不影响后面的批次
      continue
    }

    for (const m of items) {
      const text = String(m.text || '').trim()
      if (text.length < 8) continue

      // 去重：前 30 字归一化后比较（够挡住"同一句话换个标点"）
      const key = text.replace(/\s+/g, '').slice(0, 30)
      if (existing.has(key)) continue
      existing.add(key)

      const idx = Number(m.src) - 1
      const srcTurn = Number.isInteger(idx) && idx >= 0 && idx < chunk.length ? chunk[idx] : null

      out.push({
        text,
        kind: String(m.kind || 'fact'),
        owner: m.owner === 'self' ? 'self' : 'user',
        emotion: String(m.emotion || 'neutral'),
        confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0.7)),
        why: String(m.why || '').slice(0, 30),
        // 指针：指回这一轮的原话（验证时用得到）
        sourceTurn: srcTurn,
        sourceIndex: i + idx,
      })
    }
  }

  return out
}
