/**
 * bugv6 逐条验证（前端 1-7 条；第 8 条联机由 back/ 自己的测试 + 本脚本末尾的双浏览器联机用例覆盖）。
 *
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv6.ts
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv6'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })

const results: { item: string; ok: boolean; detail: string }[] = []
function check(item: string, ok: boolean, detail: unknown): void {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ item, ok, detail: text })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${text}`)
}

const HELPERS = `
window.C4 = {
  game: () => window.__CONNECT4__,
  scene: () => window.__CONNECT4__.scene.value,
  cell: (r, c) => r * 9 + c,
  scenario: (stones, options) => {
    const game = window.__CONNECT4__;
    const opts = options || {};
    game.ui.mode = opts.mode || 'pvp';
    game.ui.screen = 'playing';
    game.ui.diceVisible = false;
    game.scene.value.resetTransient();
    const board = new Array(81).fill(0);
    stones.forEach(function (entry) { board[entry[0] * 9 + entry[1]] = entry[2]; });
    game.engine.value.loadScenario(board, {
      hp: opts.hp || [6, 6],
      current: opts.current === undefined ? 0 : opts.current,
      firstPlayer: opts.current === undefined ? 0 : opts.current,
    });
    game.scene.value.setIdle(false);
    game.scene.value.setInteractive(true);
    game.scene.value.syncBoard(board);
    game.syncUi();
    return game.engine.value.phase;
  },
  pick: (cell) => { window.__CONNECT4__.handleCellPick(cell); return true; },
  // #5 波纹朝向随机
  ripplePhase: () => Number(window.C4.scene().ripple.phase.toFixed(4)),
  fireRipple: () => { window.C4.scene().ripple.fire({ color: 0xffffff, intensity: 1 }); return true; },
  ringSpin: () => {
    const rings = window.C4.scene().effects.rings;
    if (rings.length === 0) return null;
    return Number(rings[rings.length - 1].mesh.rotation.z.toFixed(4));
  },
  shockwave: () => { window.C4.scene().effects.shockwave(window.C4.scene().rig.target.clone(), { color: 0xffffff }); return true; },
  // #6 碎片颜色
  shardColors: () => {
    const shards = window.C4.scene().pieces.shards;
    const set = {};
    shards.forEach(function (s) {
      const hex = '#' + s.mesh.material.color.getHexString();
      set[hex] = (set[hex] || 0) + 1;
    });
    return set;
  },
  // #7 针状提示线的淡出曲线
  beamSamples: () => {
    const beams = window.C4.scene().effects.beams;
    if (beams.length === 0) return null;
    const beam = beams[0];
    return { opacity: Number(beam.mesh.material.opacity.toFixed(4)),
      maxLife: beam.maxLife, shape: beam.shape,
      taper: Number(beam.mesh.scale.x.toFixed(3)),
      cellToWorldY: null };
  },
  effects: () => {
    const scene = window.C4.scene();
    const effects = scene.effects;
    return { rings: effects.rings.length, beams: effects.beams.length,
      shards: scene.pieces.shards.length, rippleVisible: scene.ripple.mesh.visible };
  },
  // #1 / #2 设置弹窗结构
  settings: () => {
    const dialog = document.querySelector('.settings-dialog');
    if (!dialog) return null;
    const nav = Array.from(dialog.querySelectorAll('.settings-nav__item')).map(function (n) { return n.textContent.trim(); });
    const rect = dialog.getBoundingClientRect();
    const select = dialog.querySelector('select');
    return { nav: nav, width: Math.round(rect.width), height: Math.round(rect.height),
      selectOptions: select ? Array.from(select.options).map(function (o) { return o.value; }) : null,
      selectValue: select ? select.value : null,
      activePane: document.querySelector('.settings-nav__item.is-active').textContent.trim() };
  },
  openSettings: () => { window.__CONNECT4__.ui.showSettings = true; return true; },
  clickTab: (label) => {
    const items = Array.from(document.querySelectorAll('.settings-nav__item'));
    const target = items.find(function (n) { return n.textContent.indexOf(label) >= 0; });
    if (!target) return false;
    target.click();
    return true;
  },
  chooseBgm: (name) => {
    const select = document.querySelector('.settings-dialog select');
    if (!select) return false;
    select.value = name;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  bgm: () => { const game = window.__CONNECT4__;
    return { track: game.ui.bgmTrack, tracks: game.bgmTracks.map(function (t) { return t.name; }),
      src: (game.bgm.element && game.bgm.element.currentSrc.split('/').pop()) || null }; },
  // #3 拖尾
  trail: () => {
    const root = document.querySelector('.app-root');
    const canvases = Array.from(root.querySelectorAll('canvas')).filter(function (c) { return c.width > 100; });
    if (canvases.length === 0) return null;
    const canvas = canvases[canvases.length - 1];
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0, sumR = 0, sumG = 0, sumB = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 24) { painted += 1; sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2]; }
    }
    return { count: canvases.length, zIndex: canvas.style.zIndex, painted: painted,
      avg: painted > 0 ? [Math.round(sumR / painted), Math.round(sumG / painted), Math.round(sumB / painted)] : null };
  },
  startTrail: () => window.__CONNECT4__.startTrail(document.querySelector('.app-root'), { force: true }),
  stopTrail: () => { window.__CONNECT4__.stopTrail(); return true; },
  // #4 回放存档
  history: () => window.__CONNECT4__.history.map(function (r) {
    return { id: String(r.id), mode: r.mode, steps: r.steps.length, winner: r.result.winner }; }),
  stored: () => { try { return JSON.parse(localStorage.getItem('connect4.replays.v2') || '[]').length; } catch (e) { return -1; } },
  openReplayPanel: () => { window.__CONNECT4__.openReplay(); return true; },
  replayRows: () => document.querySelectorAll('.replay-row').length,
  deleteFirst: () => {
    const btn = document.querySelector('.replay-row .icon-btn--sm');
    if (!btn) return false;
    btn.click();
    return true;
  },
  replayPanelHeight: () => { const p = document.querySelector('.replay-panel'); return p ? Math.round(p.getBoundingClientRect().height) : 0; },
  state: () => { const game = window.__CONNECT4__; const engine = game.engine.value;
    return { phase: engine.phase, moves: engine.moveCount.value, hp: engine.hp.slice(), busy: game.ui.busy,
      mode: game.ui.mode, history: game.history.length }; },
};
'ready'
`

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const problems: string[] = []
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`[${message.type()}] ${message.text()}`)
})
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`))

await page.goto(BASE, { waitUntil: 'load' })
await page.evaluate(HELPERS)
await page.waitForTimeout(1500)

async function idle(timeoutMs = 16000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = await page.evaluate('window.C4.game().ui.busy')
    if (!busy) return
    await page.waitForTimeout(70)
  }
}

/** 摆一个局面（options 以「源码片段」传入，才能带上 hp / current 等字段）。 */
async function scenario(stones: string, options: string): Promise<void> {
  await idle()
  await page.evaluate(`window.C4.scenario(${stones}, ${options})`)
  await page.waitForTimeout(250)
}

// ===========================================================================
// #1 / #2 设置弹窗：左分节 + 右内容；背景音乐改下拉框
// ===========================================================================
{
  await page.evaluate('window.C4.openSettings()')
  await page.waitForTimeout(500)
  const info = (await page.evaluate('window.C4.settings()')) as {
    nav: string[]
    width: number
    height: number
    selectOptions: string[] | null
    selectValue: string | null
  } | null
  check(
    '#1 设置弹窗改为「左侧分节 + 右侧内容」，不再是一列到底的长表单',
    info !== null && info.nav.length >= 6 && info.width >= 600 &&
      info.nav.some((n) => n.includes('联机')) && info.activePane.includes('对局'),
    info,
  )

  await page.evaluate("window.C4.clickTab('音频')")
  await page.waitForTimeout(320)
  const audio = (await page.evaluate('window.C4.settings()')) as { selectOptions: string[] | null; selectValue: string | null } | null
  // bugv9 #7：默认曲目改成 let me go.mp3；曲库就是 assets/bgm 里的全部 mp3
  check(
    '#2 背景音乐改为下拉框，并列出 bgm 文件夹内所有 mp3',
    audio?.selectOptions !== null && (audio?.selectOptions?.length ?? 0) >= 2 &&
      (audio?.selectOptions ?? []).includes('let me go') && audio?.selectValue === 'let me go',
    audio,
  )

  const before = await page.evaluate('window.C4.bgm()')
  const otherTrack = (before.tracks as string[]).find((name: string) => name !== before.track) ?? 'piano'
  await page.evaluate(`window.C4.chooseBgm(${JSON.stringify(otherTrack)})`)
  await page.waitForTimeout(500)
  const after = await page.evaluate('window.C4.bgm()')
  check(
    '#2 下拉切换真的生效（曲目与音频源一起变化）',
    after.track === otherTrack && String(after.src).startsWith(otherTrack),
    { before, after },
  )
  await page.screenshot({ path: `${OUT}/01-settings.png` })
  await page.evaluate('window.__CONNECT4__.ui.showSettings = false')
  await page.waitForTimeout(300)
}

// ===========================================================================
// #3 鼠标拖尾：第三方库 + 蓝色
// ===========================================================================
{
  const started = await page.evaluate('window.C4.startTrail()')
  await page.waitForTimeout(200)
  await page.mouse.move(300, 300)
  await page.waitForTimeout(120)
  await page.mouse.move(900, 620, { steps: 24 })
  // bugv8 #1 把尾迹寿命收到 0.3s，这里必须紧接着采样（否则已经收干净了）
  await page.waitForTimeout(100)
  const trail = (await page.evaluate('window.C4.trail()')) as { count: number; zIndex: string; painted: number; avg: number[] | null } | null
  const avg = trail?.avg ?? [0, 0, 0]
  check(
    '#3 拖尾由第三方库（canvas 覆盖层）绘制，且是蓝色的',
    started === true && trail !== null && trail.count >= 1 && trail.painted > 200 &&
      avg[2] > avg[0] + 25 && avg[2] > 120 && trail.zIndex === '30',
    trail,
  )
  await page.screenshot({ path: `${OUT}/02-trail.png` })
}

// ===========================================================================
// #5 波纹朝向随机
// ===========================================================================
{
  await page.evaluate('window.C4.fireRipple()')
  const phaseA = await page.evaluate('window.C4.ripplePhase()')
  await page.evaluate('window.C4.fireRipple()')
  const phaseB = await page.evaluate('window.C4.ripplePhase()')
  await page.evaluate('window.C4.fireRipple()')
  const phaseC = await page.evaluate('window.C4.ripplePhase()')
  const unique = new Set([phaseA, phaseB, phaseC]).size
  check('#5 全屏波纹每次的起始角不同（朝向随机）', unique === 3, { phaseA, phaseB, phaseC })

  await page.evaluate('window.C4.shockwave()')
  const spinA = await page.evaluate('window.C4.ringSpin()')
  await page.evaluate('window.C4.scene().effects.reset()')
  await page.evaluate('window.C4.shockwave()')
  const spinB = await page.evaluate('window.C4.ringSpin()')
  check('#5 落点冲击波圆环的谱线朝向也随机', spinA !== spinB, { spinA, spinB })
}

// ===========================================================================
// #6 碎片颜色 = 双方特征色
// ===========================================================================
{
  await scenario('[[0,0,1],[0,1,1],[0,2,1],[1,3,2],[2,3,2],[3,3,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))')
  await idle()
  await page.evaluate('window.C4.pick(window.C4.cell(0,3))')
  let colors: Record<string, number> = {}
  let frames = 0
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(70)
    const sample = (await page.evaluate('window.C4.shardColors()')) as Record<string, number>
    frames += 1
    if (Object.keys(sample).length > Object.keys(colors).length) colors = sample
    if (Object.keys(colors).length >= 3) break
  }
  const keys = Object.keys(colors)
  // bugv9 #13：默认角色特征色是 DeepSeek #3964fe / Gemini #d45fb9；对撞时第三种是两者的中值
  const bugv6Palette = (await page.evaluate('window.__CONNECT4__.players.map(function (p) { return "#" + p.palette.color.toString(16).padStart(6, "0"); })')) as string[]
  const hasRed = keys.includes(bugv6Palette[0])
  const hasBlue = keys.includes(bugv6Palette[1])
  check(
    '#6 对撞碎片同时使用两种棋子的特征色（不是写死的颜色）',
    hasRed && hasBlue && keys.length >= 3,
    { colors, frames, palette: bugv6Palette },
  )
  await page.screenshot({ path: `${OUT}/03-shards.png` })
  await idle()
}

// ===========================================================================
// #7 针状提示线消失要有过渡
// ===========================================================================
{
  await scenario('[[4,4,1],[4,5,1],[2,2,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(4,3))')
  const samples: Array<{ opacity: number; taper: number }> = []
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(80)
    const sample = (await page.evaluate('window.C4.beamSamples()')) as { opacity: number; taper: number } | null
    if (sample) samples.push({ opacity: sample.opacity, taper: sample.taper })
  }
  // 淡出过程应当有若干「既没到 0 也明显变细」的中间帧
  const fading = samples.filter((s) => s.opacity > 0.005 && s.opacity < 0.6 && s.taper < 0.95)
  const minOpacity = samples.length > 0 ? Math.min(...samples.map((s) => s.opacity)) : -1
  check(
    '#7 提示针的消失是渐隐 + 渐细的过渡（有中间帧，不是直接消失）',
    samples.length >= 6 && fading.length >= 2 && minOpacity >= 0,
    { frames: samples.length, fadingFrames: fading.length, first: samples[0], last: samples[samples.length - 1] },
  )
  await page.screenshot({ path: `${OUT}/04-needle-fade.png` })
}

// ===========================================================================
// #4 回放：结束后自动保存 + 刷新后仍在 + 可删除
// ===========================================================================
{
  const before = await page.evaluate('window.C4.history()')
  await scenario('[[4,4,1],[4,5,1],[4,6,1]]', '{ hp: [6,2], current: 0 }')
  await page.evaluate('window.C4.pick(window.C4.cell(4,7))')
  await idle()
  await page.evaluate('window.C4.pick(window.C4.cell(0,0))')
  await idle()
  const after = await page.evaluate('window.C4.history()')
  const stored = await page.evaluate('window.C4.stored()')
  check(
    '#4 对局结束后自动保存回放（本地存档 + localStorage 持久化）',
    (after as unknown[]).length > (before as unknown[]).length && stored >= 1,
    { before: (before as unknown[]).length, after: (after as unknown[]).length, stored },
  )

  // 刷新页面：存档必须还在
  await page.reload({ waitUntil: 'load' })
  await page.evaluate(HELPERS)
  await page.waitForTimeout(1400)
  const reloaded = await page.evaluate('window.C4.history()')
  check('#4 刷新页面后依然能查看之前的对局', (reloaded as unknown[]).length >= 1, { count: (reloaded as unknown[]).length })

  await page.evaluate('window.C4.openReplayPanel()')
  await page.waitForTimeout(600)
  const rows = await page.evaluate('window.C4.replayRows()')
  const height = await page.evaluate('window.C4.replayPanelHeight()')
  check('#4 回放面板列出历史对局，且面板没有被列表撑爆', rows >= 1 && height < 640, { rows, height })
  await page.screenshot({ path: `${OUT}/05-replay-list.png` })

  await page.evaluate('window.C4.deleteFirst()')
  await page.waitForTimeout(400)
  const afterDelete = await page.evaluate('window.C4.history()')
  check(
    '#4 可以删除单局回放（同步写回 localStorage）',
    (afterDelete as unknown[]).length === (reloaded as unknown[]).length - 1,
    { before: (reloaded as unknown[]).length, after: (afterDelete as unknown[]).length },
  )
  await page.evaluate('window.__CONNECT4__.backToMenu()')
  await page.waitForTimeout(300)
}

// ===========================================================================
// #8 联机大厅界面（后端联机由 back/ 的测试覆盖）
// ===========================================================================
{
  await page.evaluate(`window.__CONNECT4__.setMode('online')`)
  await page.waitForTimeout(500)
  const lobby = await page.evaluate(`(() => {
    const el = document.querySelector('.online-lobby');
    if (!el) return null;
    return {
      queue: Boolean(Array.from(el.querySelectorAll('button')).find(function (b) { return b.textContent.includes('在线匹配'); })),
      create: Boolean(Array.from(el.querySelectorAll('button')).find(function (b) { return b.textContent.includes('创建房间'); })),
      join: Boolean(el.querySelector('.online-lobby__input--code')),
      // bugv11 追加 #7：大厅不再显示服务器地址 / 连接按钮（地址内置、自动连接）
      noServerInput: !el.querySelector('.online-lobby__input:not(.online-lobby__input--code)'),
      noConnectButton: !Array.from(el.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === '连接' || b.textContent.trim() === '断开'; }),
    };
  })()`)
  check('#8 联机大厅提供「在线匹配 / 创建房间 / 输入匹配码」三种入口（且不再显示连接配置）', lobby !== null && Object.values(lobby as Record<string, boolean>).every(Boolean), lobby)
  await page.screenshot({ path: `${OUT}/06-online-lobby.png` })
}

// ===========================================================================
console.log('\n============================= 汇总 =============================')
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
console.log('console problems:', problems.length ? problems : 'none')
console.log(`截图：${OUT}/`)

await browser.close()
