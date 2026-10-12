/**
 * 构建后处理：给 `dist/` 里所有"省略扩展名"的相对 import/export 补上 `.js`。
 *
 * 为什么要这一步：
 * - `src/core/*` 是从前端 `src/core/*` **逐字节复制**过来的，里面的相对导入写作
 *   `from './lines'`（Vite/前端用 bundler 解析，没有扩展名也没问题）；
 * - 编译成 ESM 后由 Node 直接运行，Node 的 ESM 解析器**要求**显式扩展名。
 *
 * 因此 `tsc` 之后统一补扩展名——只处理确实能落到真实 `.js` 文件上的说明符，
 * 其它（比如指向目录、指向第三方包）一律原样保留。
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const distDir = path.resolve(process.argv[2] ?? 'dist')

/** 匹配 `from './x'` / `import('./x')` 这类相对说明符。 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && entry.name.endsWith('.js')) yield full
  }
}

let scanned = 0
let changed = 0
let patched = 0

for await (const file of walk(distDir)) {
  scanned += 1
  const source = await readFile(file, 'utf8')
  const dir = path.dirname(file)
  const specs = new Set()
  for (const match of source.matchAll(SPECIFIER)) specs.add(match[3])
  if (specs.size === 0) continue

  const addExt = new Set()
  for (const spec of specs) {
    if (/\.(js|mjs|cjs|json)$/.test(spec)) continue
    if (await exists(path.resolve(dir, `${spec}.js`))) addExt.add(spec)
  }
  if (addExt.size === 0) continue

  const next = source.replace(SPECIFIER, (full, prefix, quote, spec) => {
    if (!addExt.has(spec)) return full
    patched += 1
    return `${prefix}${quote}${spec}.js${quote}`
  })
  if (next !== source) {
    await writeFile(file, next, 'utf8')
    changed += 1
  }
}

console.log(`[fix-esm] 扫描 ${scanned} 个文件，修正 ${changed} 个文件中的 ${patched} 处相对导入`)
