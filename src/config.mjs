/**
 * 配置加载：所有路径都从这里来，代码里不写死任何绝对路径。
 *
 * 换机器、换目录、分享给别人，只要改 config.json 一处。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 把 ~ 和相对路径展开成绝对路径 */
export function expandPath(p) {
  if (!p) return p
  let out = String(p)
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1))
  if (!path.isAbsolute(out)) out = path.join(PROJECT_ROOT, out)
  return path.normalize(out)
}

const DEFAULTS = {
  dataDir: {
    engine: '~/.dsh-memory/engine',
    archive: '~/.dsh-memory/archive',
  },
  embedding: {
    type: 'local',
    baseUrl: 'http://127.0.0.1:8090',
    model: 'BAAI/bge-m3',
    apiKey: '',
  },
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKey: '',
    batchSize: 8,
  },
  recall: {
    maxItems: 4,
    minCue: 0.35,
    minConfidence: 0.4,
    maxChars: 800,
  },
  decay: {
    episodeHalfLifeDays: 3,
    defaultHalfLifeDays: 30,
    principleHalfLifeDays: 36500,
  },
  maintenance: {
    extractEveryMinutes: 1440,
    verifyBatch: 40,
    dedupeCosineThreshold: 0.8,
    coldArchiveD: 0.06,
    coldStoreD: 0.35,
  },
}

function deepMerge(base, extra) {
  const out = { ...base }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(base[k] || {}, v)
    else out[k] = v
  }
  return out
}

let cached = null

/** 加载配置：config.json 覆盖默认值；环境变量优先（方便容器/CI） */
export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached

  const configPath = process.env.DSH_MEMORY_CONFIG || path.join(PROJECT_ROOT, 'config.json')
  let fileCfg = {}
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (e) {
    // 没有 config.json 也能跑：全用默认值 + 用户目录
  }

  const cfg = deepMerge(DEFAULTS, fileCfg)

  // 环境变量覆盖（分享给别人时最有用，不用改文件）
  if (process.env.DSH_MEMORY_DATA_DIR) {
    cfg.dataDir.engine = process.env.DSH_MEMORY_DATA_DIR
    cfg.dataDir.archive = path.join(process.env.DSH_MEMORY_DATA_DIR, '..', 'archive')
  }
  if (process.env.DSH_MEMORY_EMBED_URL) cfg.embedding.baseUrl = process.env.DSH_MEMORY_EMBED_URL
  if (process.env.DSH_MEMORY_LLM_KEY) cfg.llm.apiKey = process.env.DSH_MEMORY_LLM_KEY

  cfg.paths = {
    engineDir: expandPath(cfg.dataDir.engine),
    archiveDir: expandPath(cfg.dataDir.archive),
    engineDb: path.join(expandPath(cfg.dataDir.engine), 'engine.db'),
    archiveDb: path.join(expandPath(cfg.dataDir.archive), 'archive.db'),
    configFile: configPath,
  }

  cached = cfg
  return cfg
}

/** 确保数据目录存在（第一次跑的时候自动建） */
export function ensureDataDirs(cfg = loadConfig()) {
  fs.mkdirSync(cfg.paths.engineDir, { recursive: true })
  fs.mkdirSync(cfg.paths.archiveDir, { recursive: true })
  return cfg.paths
}
