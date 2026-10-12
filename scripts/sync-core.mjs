/**
 * 把纯逻辑内核（`src/core`）同步到后端工程（`back/src/core`）。
 *
 * 规则只有一份真源：后端为了做权威裁决必须跑同一套引擎，
 * 所以这里做**逐字节复制**，谁都不许手改 `back/src/core`。
 *
 *   pnpm sync:core
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const source = join(root, 'src', 'core')
const target = join(root, 'back', 'src', 'core')

/** 需要同步的内核文件（UI / three / ai 不参与后端）。 */
const FILES = ['types.ts', 'lines.ts', 'magic.ts', 'random.ts', 'engine.ts', 'digest.ts', 'characters.ts']

mkdirSync(target, { recursive: true })

let copied = 0
let same = 0
for (const file of FILES) {
  const from = join(source, file)
  const to = join(target, file)
  let identical = false
  try {
    identical = readFileSync(from, 'utf8') === readFileSync(to, 'utf8')
  } catch {
    identical = false
  }
  if (identical) {
    same += 1
    continue
  }
  copyFileSync(from, to)
  copied += 1
  console.log(`同步 ${file}`)
}

// 顺手提醒：back/src/core 里不应该出现多出来的文件
const extras = readdirSync(target).filter((name) => !FILES.includes(name))
if (extras.length > 0) {
  console.log(`注意：back/src/core 里还有未纳入同步的文件：${extras.join(', ')}`)
}

console.log(`内核同步完成（更新 ${copied} 个，已一致 ${same} 个）→ ${target}`)
