/**
 * REST 接口 + 可选的前端静态托管。
 *
 * 路由：
 * - `GET /api/health`         健康检查
 * - `GET /api/replays`        回放列表（playerId / limit）
 * - `GET /api/replays/:id`    单局回放
 * - `GET /api/stats`          简易统计
 * - 其余 GET 请求在前端产物存在时回退到 `index.html`（单页应用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { AppConfig } from './config'
import type { Repository } from './db'
import type { MatchManager } from './match'
import type { Logger } from './logger'
import { PROTOCOL_VERSION, type HealthResponse } from './protocol'

export interface HttpDeps {
  config: AppConfig
  repo: Repository
  matches: MatchManager
  logger: Logger
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

/** 依据配置解析 CORS 允许的来源。 */
export function resolveCorsOrigin(origins: '*' | string[], origin: string | undefined): string | null {
  if (origins === '*') return '*'
  if (!origin) return null
  return origins.includes(origin) ? origin : null
}

function readLimit(raw: unknown): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(value))
}

export function createApp(deps: HttpDeps): Express {
  const { config, repo, matches, logger } = deps
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))

  // CORS
  app.use((req: Request, res: Response, next: NextFunction) => {
    const allow = resolveCorsOrigin(config.corsOrigins, req.headers.origin)
    if (allow) {
      res.setHeader('Access-Control-Allow-Origin', allow)
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
      res.setHeader('Access-Control-Max-Age', '86400')
      if (allow !== '*') res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // --- 健康检查 ---------------------------------------------------------
  app.get('/api/health', (_req: Request, res: Response) => {
    const body: HealthResponse = {
      ok: true,
      db: repo.kind,
      uptime: Math.round(process.uptime()),
      matches: matches.size,
      version: PROTOCOL_VERSION,
    }
    res.json(body)
  })

  // --- 回放 -------------------------------------------------------------
  app.get('/api/replays', async (req: Request, res: Response) => {
    const playerId = typeof req.query.playerId === 'string' && req.query.playerId !== '' ? req.query.playerId : undefined
    // bugv34k：优先按登录账号过滤（同一账号换设备也看得到自己的回放）
    const rawAccount = typeof req.query.account === 'string' ? req.query.account.trim().toLowerCase() : ''
    const account = rawAccount !== '' ? rawAccount : undefined
    const limit = readLimit(req.query.limit)
    try {
      const items = await repo.listReplays({ playerId, account, limit })
      res.json({ ok: true, count: items.length, limit, playerId: playerId ?? null, account: account ?? null, items })
    } catch (error) {
      logger.error('查询回放列表失败', error)
      res.status(500).json({ ok: false, error: 'serverBusy' })
    }
  })

  app.get('/api/replays/:id', async (req: Request, res: Response) => {
    try {
      const replay = await repo.getReplay(req.params.id)
      if (!replay) {
        res.status(404).json({ ok: false, error: 'notFound', message: `回放 ${req.params.id} 不存在` })
        return
      }
      res.json({ ok: true, replay })
    } catch (error) {
      logger.error('查询单局回放失败', error)
      res.status(500).json({ ok: false, error: 'serverBusy' })
    }
  })

  // --- 统计 -------------------------------------------------------------
  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await repo.stats()
      res.json({
        ok: true,
        db: repo.kind,
        uptime: Math.round(process.uptime()),
        version: PROTOCOL_VERSION,
        matches: { total: matches.size, active: matches.activeCount },
        replays: stats,
      })
    } catch (error) {
      logger.error('查询统计失败', error)
      res.status(500).json({ ok: false, error: 'serverBusy' })
    }
  })

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'notFound' })
  })

  // --- 前端静态托管 -----------------------------------------------------
  if (config.serveFrontend) {
    const indexFile = path.join(config.frontendDir, 'index.html')
    const hasFrontend = fs.existsSync(indexFile)
    if (!hasFrontend) {
      // 文件不存在静默跳过（只要 /api 与 /ws 可用就不影响联机）
      logger.warn(`SERVE_FRONTEND=true 但未找到前端产物：${indexFile}（已跳过静态托管）`)
    } else {
      app.use(
        express.static(config.frontendDir, {
          index: ['index.html'],
          fallthrough: true,
          maxAge: '1h',
          setHeaders: (res, filePath) => {
            if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
          },
        }),
      )
      logger.info(`已托管前端产物：${config.frontendDir}`)
      app.get('*', (req: Request, res: Response, next: NextFunction) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
          next()
          return
        }
        res.sendFile(indexFile, (error) => {
          if (error) next(error)
        })
      })
    }
  }

  // 兜底 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'notFound', path: req.path })
  })

  // 统一错误处理
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP 处理出错', error)
    if (res.headersSent) return
    res.status(500).json({ ok: false, error: 'serverBusy', message: error.message })
  })

  return app
}
