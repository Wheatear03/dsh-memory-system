#!/usr/bin/env node
/**
 * 演示：不用 API key，也不用真对话，看这套系统怎么记、怎么忘、怎么找。
 *
 * 跑法：
 *   node examples/demo.mjs
 *
 * 它会建一个临时库（不影响你的真实数据），塞几条示例记忆，
 * 然后演示不同时间点的衰减和检索结果。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decay, grams, retrievability } from '../src/scoring.mjs'

const DAY = 86400000
const TMP = path.join(os.tmpdir(), 'dsh-memory-demo-' + Date.now())

const NOW = Date.now()
const mk = (o) => ({ S0: 0.5, D0: 0.5, E0: 0.3, C0: 0.7, hits: 0, kind: 'fact', ...o })

const samples = [
  ['刚发生的事', mk({ text: '刚才把 8090 端口改到了 8091', at: NOW, created: NOW })],
  ['四天前的一次调试', mk({ text: '今天这个 SQL 又报错了，看了半天才发现是参数顺序反了', at: NOW - 4 * DAY, created: NOW - 4 * DAY, kind: 'episode' })],
  ['同样四天的教训', mk({ text: '加载异常时先确认加载对象，再查参数', at: NOW - 4 * DAY, created: NOW - 4 * DAY, kind: 'lesson' })],
  ['一个月前的偏好', mk({ text: '用户讨厌在群里发语音，说太吵', at: NOW - 30 * DAY, created: NOW - 30 * DAY })],
  ['钉住的设定', mk({ text: '用户的名字是阿鲸，这个永远不能忘', at: NOW - 365 * DAY, created: NOW - 365 * DAY, pinned: 1, kind: 'principle' })],
]

function bar(v, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(v * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}

console.log('='.repeat(62))
console.log('一、衰减：同样写进去，过一段时间之后')
console.log('='.repeat(62))
console.log('（S = 意义强度，越快淡忘越低；D = 细节强度）\n')
for (const [name, m] of samples) {
  const d = decay(m, NOW)
  console.log(name.padEnd(16), 'S', bar(d.S), d.S.toFixed(2), ' D', bar(d.D), d.D.toFixed(2))
}

console.log('\n' + '='.repeat(62))
console.log('二、检索：问「加载失败的教训」能找回什么')
console.log('='.repeat(62))
const qg = grams('加载失败的教训')
for (const [name, m] of samples) {
  const r = retrievability(m, qg, NOW, null)
  console.log(name.padEnd(16), 'R=' + r.R.toFixed(3), r.R >= 0.35 ? '← 命中' : '')
}

console.log('\n' + '='.repeat(62))
console.log('三、看出来的事')
console.log('='.repeat(62))
console.log('· 四天前的「一次调试」被断崖压到很低（D=0.05 左右）——单次经历该淡')
console.log('· 同样四天的「教训」还在——提炼过的经验该留')
console.log('· 一个月前的偏好还在中段——关于人的事衰减慢')
console.log('· 钉住的设定一年了 S 还是满的——重要的事不该掉')
console.log('· 检索不是只看新旧，还看内容对不对得上')

fs.rmSync(TMP, { recursive: true, force: true })
