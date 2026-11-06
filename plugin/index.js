/**
 * dsh-memory-system 插件（宿主半边）
 *
 * 每轮对话开始前，拿用户这句话去检索记忆，把相关的几条注入上下文。
 *
 * 三条纪律（都是踩坑踩出来的）：
 *   1. DSH 没有 agent 创建事件 —— 只能轮询 ctx.agents.list()
 *   2. 记忆出任何问题都必须安静返回空串，不能拖垮整轮对话
 *   3. interpolate: false —— 记忆文本里可能有 `{{...}}`，被当变量解析会抛错
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export const name = 'dsh-memory-system'
export const inject = ['systemPrompt', 'agents']

/** 插件实际装在 profile 里，引擎路径通过环境变量或默认值找 */
const ENGINE_DIR = process.env.DSH_MEMORY_ENGINE_DIR
  || 'C:\\Users\\Agony\\Documents\\deepseek-harness\\default-workspace\\dsh-memory-system'
const ENGINE = ENGINE_DIR + '\\src\\engine.mjs'
const TIMEOUT = 6000

function diag(msg) {
  try {
    fs.appendFileSync(ENGINE_DIR + '\\plugin.log', `[${new Date().toISOString()}] ${msg}\n`)
  } catch { /* 诊断失败不影响功能 */ }
}

/** 从消息里剥出人真正说的那句（DSH 会往 user 消息里塞大量注入） */
function cleanUserText(raw) {
  return String(raw || '')
    .replace(/<dsh-[^>]*>[\s\S]*?<\/dsh-[^>]*>/gi, '')   // DSH 自己的注入块
    .replace(/^【[^】]{2,12}】[^\n]*\n?/gm, '')          // 【xx】开头的行
    .replace(/Current runtime context[\s\S]*$/i, '')     // 运行时上下文
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function textOfMessage(msg) {
  try {
    if (!msg) return ''
    if (typeof msg === 'string') return msg
    if (msg.content) {
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        return msg.content.filter((x) => x && (x.type === 'text' || typeof x.text === 'string'))
          .map((x) => x.text || '').join(' ')
      }
    }
    if (typeof msg.text === 'string') return msg.text
    return ''
  } catch { return '' }
}

/** 调引擎做检索 */
function recallText(query) {
  if (!query || String(query).trim().length < 3) return ''
  try {
    const safe = String(query)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
    if (!safe) return ''

    const out = execFileSync(process.execPath, [ENGINE, 'recall', safe], {
      cwd: ENGINE_DIR,
      timeout: TIMEOUT,
      encoding: 'utf8',
      windowsHide: true,
    })
    return String(out || '').trim()
  } catch {
    return ''   // 记忆出问题，安静跳过
  }
}

export function apply(ctx) {
  const mounted = new Set()

  function mountFor(agent) {
    let lastText = ''
    try {
      agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload && payload.message ? payload.message : payload
        const txt = cleanUserText(textOfMessage(msg))
        if (txt) lastText = txt
      })
    } catch (e) { diag('监听 inbox 失败：' + (e && e.message)) }

    try {
      agent.ctx.systemPrompt.context({
        name: 'dsh-memory-system',
        order: 910,          // 靠后：记忆是每轮都变的内容，不能破坏前面的缓存
        interpolate: false,
        text: () => {
          try {
            if (!lastText) return ''
            return recallText(lastText)
          } catch (e) { diag('注入出错：' + (e && e.message)); return '' }
        },
      })
      diag('注入点挂上了')
    } catch (e) { diag('挂注入点失败：' + (e && e.message)) }
  }

  function tick() {
    try {
      const list = (ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []) || []
      for (const agent of list) {
        if (!agent || mounted.has(agent)) continue
        mounted.add(agent)
        mountFor(agent)
      }
    } catch (e) { diag('tick 出错：' + (e && e.message)) }
  }

  tick()
  try {
    const timer = setInterval(tick, 2000)
    if (timer && typeof timer.unref === 'function') timer.unref()
    ctx.on('dispose', () => clearInterval(timer))
  } catch (e) { diag('定时器没挂上：' + (e && e.message)) }
}
