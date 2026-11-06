#!/usr/bin/env node
/**
 * 记忆引擎入口。
 *
 * 命令：
 *   init        建库（第一次用）
 *   health      自检
 *   remember    手动记一条
 *   recall      检索（给插件用）
 *   forget      归档一条（不删除，退出召回）
 */
import { loadConfig } from './config.mjs'
import { openDb, insertMem, findById } from './storage.mjs'
import { recall, formatForPrompt } from './recall.mjs'
import { buildEdges, neighbors, spread } from './graph.mjs'

const cfg = loadConfig()
const [cmd, ...args] = process.argv.slice(2)

function arg(name, dflt = '') {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt
}

function positional() {
  return args.filter((a) => !a.startsWith('--'))
}

if (cmd === 'init') {
  const db = openDb(cfg)
  const n = db.prepare('select count(*) c from mem').get().c
  db.close()
  console.log(JSON.stringify({
    ok: true,
    engineDb: cfg.paths.engineDb,
    archiveDb: cfg.paths.archiveDb,
    memories: n,
    note: n === 0 ? '空库，可以开始用了' : '已有数据',
  }, null, 1))

} else if (cmd === 'health') {
  const db = openDb(cfg)
  const total = db.prepare('select count(*) c from mem').get().c
  const active = db.prepare("select count(*) c from mem where status='active' and archived=0").get().c
  const archived = db.prepare('select count(*) c from mem where archived=1').get().c
  const pinned = db.prepare('select count(*) c from mem where pinned=1').get().c
  const vec = db.prepare('select count(*) c from mem where vec is not null').get().c
  db.close()
  console.log(JSON.stringify({
    ok: true,
    engineDb: cfg.paths.engineDb,
    counts: { total, active, archived, pinned, withVector: vec },
    embed: cfg.embedding.baseUrl,
  }, null, 1))

} else if (cmd === 'remember') {
  const text = positional()[0]
  if (!text) { console.error('用法: engine.mjs remember "要记的内容" [--kind fact] [--owner user]'); process.exit(1) }
  const db = openDb(cfg)
  const now = Date.now()
  const id = 'm-' + now.toString(36) + '-' + Math.floor(Math.random() * 1000)
  insertMem(db, {
    id, text,
    kind: arg('kind', 'fact'),
    owner: arg('owner', 'user'),
    source: 'manual',
    at: now,
    confidence: 0.8,
  })
  db.close()
  console.log(JSON.stringify({ ok: true, id, text: text.slice(0, 40) }, null, 1))

} else if (cmd === 'recall') {
  const q = positional()[0] || ''
  if (!q) { console.error('用法: engine.mjs recall "查询" [--mode work|review] [--limit N] [--json]'); process.exit(1) }
  const db = openDb(cfg)
  const out = await recall(db, q, {
    mode: arg('mode', 'work'),
    limit: arg('limit') ? parseInt(arg('limit'), 10) : undefined,
    cfg,
  })
  db.close()
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 1))
  else process.stdout.write(formatForPrompt(out.hits, cfg) + '\n')

} else if (cmd === 'graph') {
  // 建边：同一天 / 同一轮 / 语义相似
  const db = openDb(cfg)
  const out = buildEdges(db, { cfg, skipSimilar: args.includes('--fast') })
  db.close()
  console.log(JSON.stringify(out, null, 1))

} else if (cmd === 'neighbors') {
  const id = positional()[0]
  if (!id) { console.error('用法: engine.mjs neighbors <id>'); process.exit(1) }
  const db = openDb(cfg)
  const out = neighbors(db, id, 20)
  db.close()
  console.log(JSON.stringify({ ok: true, id, neighbors: out }, null, 1))

} else if (cmd === 'spread') {
  const ids = positional()
  if (!ids.length) { console.error('用法: engine.mjs spread <id1> [id2...]'); process.exit(1) }
  const db = openDb(cfg)
  const out = spread(db, ids, { limit: 10 })
  db.close()
  console.log(JSON.stringify({ ok: true, seeds: ids, spread: out }, null, 1))

} else if (cmd === 'forget') {
  const id = positional()[0]
  if (!id) { console.error('用法: engine.mjs forget <id>'); process.exit(1) }
  const db = openDb(cfg)
  const m = findById(db, id)
  if (!m) { console.log(JSON.stringify({ ok: false, error: '没有这条' }, null, 1)); process.exit(1) }
  // 归档不是删除：退出召回，但记录还在，随时能改回来
  db.prepare('update mem set archived = 1 where id = ?').run(id)
  db.close()
  console.log(JSON.stringify({ ok: true, id, archived: true, text: String(m.text).slice(0, 40) }, null, 1))

} else {
  console.log(JSON.stringify({
    ok: false,
    error: '未知命令: ' + (cmd || '(空)'),
    commands: {
      init: '建库',
      health: '自检',
      remember: 'remember "内容" [--kind fact] [--owner user]',
      recall: 'recall "查询" [--mode work|review] [--limit N] [--json]',
      graph: '建边（同一天 / 同一轮 / 语义相似）',
      neighbors: 'neighbors <id>（看一条记忆连着谁）',
      spread: 'spread <id...>（沿边扩散找相关）',
      forget: 'forget <id>（归档，不删除）',
    },
  }, null, 1))
  process.exit(1)
}
