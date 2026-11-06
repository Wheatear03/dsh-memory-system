/**
 * 存储层：数据库的打开、建表和基础查询。
 *
 * 设计约束：所有路径来自 config，代码里不出现绝对路径。
 * 换机器 / 分享给别人，只要改 config.json。
 */
import { DatabaseSync } from 'node:sqlite'
import { loadConfig, ensureDataDirs } from './config.mjs'

/** 完整的表结构。字段注释就是它们的用途。 */
const SCHEMA = `
create table if not exists mem (
  id            text primary key,
  text          text not null,
  kind          text default 'fact',
  source        text default 'manual',      -- manual / llm_extracted / reconstructed_detail
  source_mid    text,                        -- 指针：指回 archive 里那一轮原话
  owner         text default 'user',         -- user（关于用户的）/ self（自己学到的）
  scope         text default 'user',
  at            integer,                     -- 事件发生时间
  created       integer,
  cursor_at     integer,
  S0            real default 0.5,            -- 初始意义强度
  D0            real default 0.5,            -- 初始细节强度
  E0            real default 0.3,            -- 初始情绪唤醒
  C0            real default 0.7,            -- 初始置信
  hits          integer default 0,           -- 被回忆次数
  last_hit      integer,
  confidence    real default 0.7,            -- 当前置信度（验证后可能被压）
  verified      integer default 0,           -- 0 未验证 / 1 通过 / 2 无需验证
  verify_note   text,
  pinned        integer default 0,           -- 钉住：永不过期
  status        text default 'active',       -- active / superseded / fused
  superseded_by text,                        -- 墓碑指针：指向取代它的新版本
  archived      integer default 0,           -- 归档（退出召回但保留）
  cold          integer default 0,           -- 冷存（细节快忘了）
  interference  real default 0,              -- 干扰度缓存
  emotion_label text,
  vec           blob                         -- 向量（Float32 小端）
);
create index if not exists idx_mem_active on mem(status, archived);
create index if not exists idx_mem_at on mem(at);

create table if not exists kv (k text primary key, value text);
create table if not exists recall_log (ts integer, query text, picked text, detail text);
create table if not exists link (a text, b text, weight real, primary key (a, b));
`

/** 打开（不存在就建）数据库 */
export function openDb(cfg = loadConfig()) {
  ensureDataDirs(cfg)
  const db = new DatabaseSync(cfg.paths.engineDb)
  db.exec('PRAGMA busy_timeout = 8000')  // 撞上锁就等，别直接报错
  db.exec('PRAGMA journal_mode = WAL')   // 读写可以并发
  db.exec(SCHEMA)
  return db
}

/** 参与召回的候选：活跃、未归档、冷存例外（钉住的冷存也算） */
export function listCandidates(db) {
  return db.prepare(
    "select * from mem where archived = 0 and status in ('active','superseded','fused') and (cold = 0 or pinned = 1)"
  ).all()
}

export function findById(db, id) {
  return db.prepare('select * from mem where id = ?').get(id) || null
}

export function insertMem(db, m) {
  const now = Date.now()
  db.prepare(`
    insert into mem (id, text, kind, source, source_mid, owner, scope, at, created,
                     S0, D0, E0, C0, confidence, emotion_label, vec)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    m.id, m.text, m.kind || 'fact', m.source || 'manual', m.sourceMid || null,
    m.owner || 'user', m.scope || 'user', m.at || now, m.created || now,
    m.S0 ?? 0.5, m.D0 ?? 0.5, m.E0 ?? 0.3, m.C0 ?? 0.7,
    m.confidence ?? 0.7, m.emotionLabel || null, m.vec || null,
  )
  return m.id
}

/** 墓碑解析：顺着 superseded_by 找到正主（防止指针成环，最多 8 跳） */
export function makeResolver(db) {
  const alias = new Map()
  for (const t of db.prepare(
    "select id, superseded_by from mem where status in ('superseded','fused') and superseded_by is not null"
  ).all()) alias.set(t.id, t.superseded_by)

  return (id) => {
    let cur = id, guard = 0
    while (alias.has(cur) && guard++ < 8) cur = alias.get(cur)
    return cur
  }
}

/** 记录一次召回（用于统计和后续调整） */
export function logRecall(db, query, picked, detail = '') {
  try {
    db.prepare('insert into recall_log (ts, query, picked, detail) values (?,?,?,?)')
      .run(Date.now(), String(query).slice(0, 200), JSON.stringify(picked), String(detail).slice(0, 500))
  } catch { /* 记录失败不影响召回 */ }
}

/** 简单键值（放每日回顾之类的短文本） */
export function kvGet(db, key) {
  const r = db.prepare('select value from kv where k = ?').get(key)
  return r ? r.value : null
}

export function kvSet(db, key, value) {
  db.prepare('insert or replace into kv (k, value) values (?, ?)').run(key, String(value))
}
