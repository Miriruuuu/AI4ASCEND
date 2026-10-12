/**
 * 配置解析单测：Mongo 连接串拼接（含特殊字符 URL 编码）、模式降级、CORS、相对路径解析。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { PACKAGE_ROOT, buildMongoUri, loadConfig, parseMongoUri } from '../src/config'

describe('buildMongoUri', () => {
  it('没有账号时直接使用 MONGODB_URI，仅在缺库名时补上 DB_NAME', () => {
    expect(buildMongoUri({ MONGODB_URI: 'mongodb://127.0.0.1:27017', DB_NAME: 'miriru' })).toBe(
      'mongodb://127.0.0.1:27017/miriru',
    )
    expect(
      buildMongoUri({ MONGODB_URI: 'mongodb://127.0.0.1:27017/existing?retryWrites=true', DB_NAME: 'miriru' }),
    ).toBe('mongodb://127.0.0.1:27017/existing?retryWrites=true')
    expect(buildMongoUri({})).toBeNull()
  })

  it('有账号时拼成 user:pass@host/db?authSource=admin', () => {
    const uri = buildMongoUri({
      MONGODB_URI: 'mongodb://190.92.233.254:27017',
      MONGODB_USER: 'miriru',
      MONGODB_PASSWORD: 'lin162636',
      DB_NAME: 'miriru',
    })
    expect(uri).toBe('mongodb://miriru:lin162636@190.92.233.254:27017/miriru?authSource=admin')
  })

  it('密码里的特殊字符会被 URL 编码', () => {
    const uri = buildMongoUri({
      MONGODB_URI: 'mongodb://db.example.com:27017',
      MONGODB_USER: 'user@name',
      MONGODB_PASSWORD: 'p@ss:w/rd?#1',
      DB_NAME: 'connect4',
    })
    expect(uri).toBe('mongodb://user%40name:p%40ss%3Aw%2Frd%3F%231@db.example.com:27017/connect4?authSource=admin')
    // 编码后必须能被解析回原值
    const url = new URL(uri as string)
    expect(decodeURIComponent(url.username)).toBe('user@name')
    expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd?#1')
    expect(url.hostname).toBe('db.example.com')
    expect(url.pathname).toBe('/connect4')
    expect(url.searchParams.get('authSource')).toBe('admin')
  })

  it('MONGODB_AUTH_SOURCE 可覆盖默认的 admin', () => {
    const uri = buildMongoUri({
      MONGODB_URI: 'mongodb://127.0.0.1:27017',
      MONGODB_USER: 'u',
      MONGODB_PASSWORD: 'p',
      DB_NAME: 'c4',
      MONGODB_AUTH_SOURCE: 'miriru',
    })
    expect(uri).toBe('mongodb://u:p@127.0.0.1:27017/c4?authSource=miriru')
  })

  it('parseMongoUri 能拆出多主机与已有 query', () => {
    const parsed = parseMongoUri('mongodb://a:1,b:2/app?replicaSet=rs0&authSource=admin')
    expect(parsed.hosts).toBe('a:1,b:2')
    expect(parsed.database).toBe('app')
    expect(parsed.query).toBe('replicaSet=rs0&authSource=admin')
  })
})

describe('loadConfig', () => {
  it('默认值', () => {
    const config = loadConfig({})
    expect(config.port).toBe(8787)
    expect(config.dbName).toBe('connect4')
    expect(config.dbMode).toBe('mongo')
    expect(config.roomTtlMs).toBe(600_000)
    expect(config.matchTtlMs).toBe(1_800_000)
    expect(config.corsOrigins).toBe('*')
    expect(config.serveFrontend).toBe(true)
    expect(config.mongoAuthSource).toBe('admin')
    // 相对路径按 back/ 根目录解析
    expect(config.frontendDir).toBe(path.resolve(PACKAGE_ROOT, '../dist'))
  })

  it('没有 MONGODB_URI 时自动降级为内存模式', () => {
    const config = loadConfig({ DB_MODE: 'mongo' })
    expect(config.dbMode).toBe('mongo')
    expect(config.mongodbUri).toBeNull()
    expect(config.effectiveDbMode).toBe('memory')
  })

  it('DB_MODE=memory 不解析连接串', () => {
    const config = loadConfig({
      DB_MODE: 'memory',
      MONGODB_URI: 'mongodb://190.92.233.254:27017',
      MONGODB_USER: 'miriru',
    })
    expect(config.mongodbUri).toBeNull()
    expect(config.effectiveDbMode).toBe('memory')
  })

  it('CORS_ORIGINS 支持逗号分隔与布尔/数字解析', () => {
    const config = loadConfig({
      DB_MODE: 'memory',
      CORS_ORIGINS: 'https://a.com, http://localhost:5173 ,',
      SERVE_FRONTEND: 'false',
      PORT: '9000',
      LOG_LEVEL: 'debug',
    })
    expect(config.corsOrigins).toEqual(['https://a.com', 'http://localhost:5173'])
    expect(config.serveFrontend).toBe(false)
    expect(config.port).toBe(9000)
    expect(config.logLevel).toBe('debug')
  })
})
