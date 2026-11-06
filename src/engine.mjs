#!/usr/bin/env node
/**
 * 记忆引擎入口（骨架版）
 *
 * 现在的命令：
 *   init      建库（第一次用）
 *   health    自检
 *   remember  手动记一条
 *   recall    检索
 *
 * 数据文件位置全部来自 config.json，代码里不写死路径。
 */
import { DatabaseSync } from 'node:sqlite'
import { loadConfig, ensureDataDirs } from './config.mjs'

const cfg = loadConfig()
const [cmd, ...args] = process.argv.slice(2)

function openDb() {
  ensureDataDirs(cfg)
  const db = new DatabaseSync(cfg.paths.engineDb)
  db.exec('PRAGMA busy_timeout = 8000')
  db.exec('PRAGMA journal_mode = WAL')
  return db
}

function initSchema(db) {
  db.exec(`
    create table if not exists mem (
      id          text primary key,
      text        text not null,
      kind        text default 'fact',
      owner       text default 'user',
      source      text default 'manual',
      source_mid  text,
      at          integer not null,
      created     integer not null,
      S0          real default 0.5,
      D0          real default 0.5,
      E0          real default 0.3,
      C0          real default 0.7,
      hits        integer default 0,
      last_hit    integer,
      confidence  real default 0.7,
      pinned      integer default 0,
      status      text default 'active',
      superseded_by text,
      archived    integer default 0,
      cold        integer default 0,
      interference real default 0,
      emotion_label text,
      scope       text default 'user',
      vec         blob
    );
    create index if not exists idx_mem_status on mem(status, archived);
    create table if not exists kv (k text primary key, value text);
    create table if not exists recall_log (ts integer, query text, picked text, detail text);
    create table if not exists link (a text, b text, weight real, primary key (a, b));
  `)
}

if (cmd === 'init') {
  const db = openDb()
  initSchema(db)
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
  const db = openDb()
  initSchema(db)
  const total = db.prepare('select count(*) c from mem').get().c
  const active = db.prepare("select count(*) c from mem where status='active' and archived=0").get().c
  const archived = db.prepare('select count(*) c from mem where archived=1').get().c
  const pinned = db.prepare('select count(*) c from mem where pinned=1').get().c
  db.close()
  console.log(JSON.stringify({
    ok: true,
    engineDb: cfg.paths.engineDb,
    counts: { total, active, archived, pinned },
  }, null, 1))
} else if (cmd === 'remember') {
  const text = args.find((a) => !a.startsWith('--'))
  if (!text) { console.error('用法: engine.mjs remember "要记的内容" [--kind fact] [--owner user]'); process.exit(1) }
  const kind = (args[args.indexOf('--kind') + 1] || 'fact')
  const owner = (args[args.indexOf('--owner') + 1] || 'user')
  const db = openDb()
  initSchema(db)
  const now = Date.now()
  const id = 'm-' + now.toString(36) + '-' + Math.floor(Math.random() * 1000)
  db.prepare(
    'insert into mem (id, text, kind, owner, source, at, created, S0, D0, E0, C0) values (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, text, kind, owner, 'manual', now, now, 0.5, 0.5, 0.3, 0.7)
  db.close()
  console.log(JSON.stringify({ ok: true, id, text: text.slice(0, 40) }, null, 1))
} else {
  console.log(JSON.stringify({
    ok: false,
    error: '未知命令: ' + (cmd || '(空)'),
    usage: 'engine.mjs init | health | remember "内容" [--kind fact] [--owner user]',
  }, null, 1))
  process.exit(1)
}
