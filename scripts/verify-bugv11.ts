/**
 * bugv11 逐条验证（**只跑这一轮的问题**，bugv3 ~ bugv10 的旧脚本按需求不跑）。
 *
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv11.ts
 *
 * #1 恶龙吐息的烈焰 6 回合（双方各走一步算 1 回合）后必须熄灭，不会永远烧下去 ·
 * #2 使用技能后技能框高亮 + 流光一段时间（对手也看得见）·
 * #3 技能详情的泡泡点"泡泡外面"也要能关掉 ·
 * #4 魔力植物按部位分色（每块纯色，不再叠层混色）·
 * #5 双子星：本回合两连即可发起攻击 + 免疫反击伤害 ·
 * #6 恶龙吐息开局不进入冷却、首次释放不消耗魔力植物 ·
 * #7 攻击阶段立绘保持 atk，攻击结束回默认（对撞打平不再退回 atk）
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv11'
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
  engine: () => window.__CONNECT4__.engine.value,
  cell: (r, c) => r * 9 + c,
  scenario: (stones, options) => {
    const game = window.__CONNECT4__;
    const opts = options || {};
    game.ui.mode = opts.mode || 'pvp';
    game.ui.screen = 'playing';
    game.ui.diceVisible = false;
    game.players[0].isAi = false;
    game.players[1].isAi = false;
    if (opts.characters) {
      game.setCharacter(0, opts.characters[0]);
      game.setCharacter(1, opts.characters[1]);
    }
    if (game.resetRecording) game.resetRecording();
    game.ui.showResult = false;
    game.ui.result = null;
    game.ui.notice = null;
    game.ui.skillSelect = null;
    game.ui.skillBubble = null;
    game.resetSkillFlash();
    const scene = game.scene.value;
    scene.resetTransient();
    scene.setSkillSelecting(null);
    const board = new Array(81).fill(0);
    stones.forEach(function (entry) { board[entry[0] * 9 + entry[1]] = entry[2]; });
    const players = opts.current === undefined ? 0 : opts.current;
    game.engine.value.loadScenario(board, {
      hp: opts.hp || [6, 6],
      current: players,
      firstPlayer: players,
      magic: opts.magic || [],
      magicGrowths: opts.magicGrowths || 0,
      magicCooldown: opts.magicCooldown === undefined ? 10 : opts.magicCooldown,
      magicLineSeen: Boolean(opts.magicLineSeen),
      shield: opts.shield || [0, 0],
      bonusActions: opts.bonusActions || [0, 0],
      lastPlacedBy: opts.lastPlacedBy || [null, null],
      twinStar: opts.twinStar || [false, false],
    });
    if (opts.skillReady) {
      opts.skillReady.forEach(function (entry) { game.engine.value.skillReadyAt[entry[0]][entry[1]] = 0; });
    }
    if (opts.skillCasts) {
      opts.skillCasts.forEach(function (entry) {
        game.engine.value.skillCasts[entry[0]][entry[1]] = entry[2];
      });
    }
    scene.setIdle(false);
    scene.setInteractive(true);
    scene.syncBoard(board);
    scene.syncMagic(Array.from(game.engine.value.magic.values()));
    scene.syncFlames(Array.from(game.engine.value.flames.entries()));
    game.syncUi();
    return game.engine.value.phase;
  },
  pick: (cell) => window.__CONNECT4__.handleCellPick(cell),
  pickStart: (cell) => { void window.__CONNECT4__.handleCellPick(cell); return true; },
  idle: () => !window.__CONNECT4__.ui.busy,
  toggleSkill: (player, slot) => window.__CONNECT4__.toggleSkill(player, slot),
  cancelSkill: () => window.__CONNECT4__.cancelSkillSelect(),
  skills: (player) => JSON.parse(JSON.stringify(window.__CONNECT4__.ui.skills[player])),
  state: () => {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return { screen: game.ui.screen, busy: game.ui.busy, phase: engine.phase, uiPhase: game.ui.phase,
      magicCount: game.ui.magicCount, current: engine.current, turnNo: engine.turnNo,
      highlightOwner: engine.highlightOwner, highlights: engine.highlights.size,
      flames: engine.flames.size, uiFlames: game.ui.flames.length, overlay: engine.overlay.size,
      twinStar: [engine.twinStar[0], engine.twinStar[1]],
      skillCasts: [[...engine.skillCasts[0]], [...engine.skillCasts[1]]],
      skillSelect: game.ui.skillSelect ? { player: game.ui.skillSelect.player, slot: game.ui.skillSelect.slot,
        picked: game.ui.skillSelect.picked.length, need: game.ui.skillSelect.need, stage: game.ui.skillSelect.stage,
        target: game.ui.skillSelect.target } : null,
      skillBubble: game.ui.skillBubble ? { ...game.ui.skillBubble } : null,
      skillFlash: game.ui.skillFlash ? { ...game.ui.skillFlash } : null,
      hint: game.ui.hint, expression: [...game.ui.expression], hp: [...engine.hp] };
  },
  hp: () => window.__CONNECT4__.engine.value.hp.slice(),
  flames: () => Array.from(window.__CONNECT4__.engine.value.flames.entries()).sort(function (a, b) { return a[0] - b[0]; }),
  flameScene: () => window.__CONNECT4__.scene.value.flames.cells.slice().sort(function (a, b) { return a - b; }),
  snap: () => JSON.parse(JSON.stringify(window.__CONNECT4__.engine.value.attack)),
  magic: () => Array.from(window.__CONNECT4__.engine.value.magic.values()).map(function (p) { return { cell: p.cell, kind: p.kind, owner: p.owner }; }),
  // --- #2 技能框流光 / #3 气泡 ---
  skillDom: (player) => {
    const bar = document.querySelector('[data-skill-bar="' + player + '"]');
    if (!bar) return null;
    const slots = Array.prototype.slice.call(bar.querySelectorAll('.skill-slot'));
    return slots.map(function (slot) {
      const flashLayer = slot.querySelector('.skill-slot__flash');
      const style = getComputedStyle(slot);
      return {
        skill: slot.getAttribute('data-skill'),
        flash: slot.classList.contains('is-flash'),
        flashKey: slot.getAttribute('data-flash'),
        flashLayer: !!flashLayer,
        flashAnimation: flashLayer ? getComputedStyle(flashLayer).animationName : null,
        slotAnimation: style.animationName,
        bubble: !!slot.querySelector('.skill-bubble'),
        costText: (slot.querySelector('.skill-slot__cost') || {}).textContent || '',
        stateText: (slot.querySelector('.skill-slot__state') || {}).textContent || '',
      };
    });
  },
  bubbleText: () => {
    const bubble = document.querySelector('.skill-bubble');
    return bubble ? bubble.textContent.replace(/\\s+/g, ' ').trim() : null;
  },
  // --- #4 魔力植物配色 ---
  plantColors: (cell) => {
    const record = window.__CONNECT4__.scene.value.magic.at(cell);
    if (!record) return null;
    const hex = function (material) { return '#' + material.color.getHexString(); };
    const meshes = record.plant.children.filter(function (child) { return child.isMesh; });
    return {
      kind: record.kind,
      meshColors: meshes.map(function (mesh) { return hex(mesh.material); }),
      opacity: meshes.map(function (mesh) { return Number(mesh.material.opacity.toFixed(2)); }),
      transparent: meshes.map(function (mesh) { return !!mesh.material.transparent; }),
      names: meshes.map(function (mesh) { return mesh.name; }),
      parts: { leaves: record.parts.leaves, stems: record.parts.stems,
        maxLeafGap: Number(record.parts.maxLeafGap.toFixed(4)), bend: Number(record.parts.bend.toFixed(4)) },
    };
  },
  // --- #7 立绘 ---
  expressions: () => [0, 1].map(function (side) {
    const panel = document.querySelector('[data-player-panel="' + side + '"]');
    return panel ? panel.getAttribute('data-expression') : null;
  }),
  /** 记下每一次立绘变化（用于"攻击阶段不能掉回默认"的判定）。 */
  watchExpressions: () => {
    if (window.C4.__exprWatch) return true;
    const log = [];
    window.C4.__exprWatch = log;
    window.C4.__exprTimer = setInterval(function () {
      const pair = window.C4.expressions();
      const text = pair.join('|');
      if (log[log.length - 1] !== text) log.push(text);
    }, 25);
    return true;
  },
  exprLog: () => (window.C4.__exprWatch || []).slice(),
  stopWatch: () => { clearInterval(window.C4.__exprTimer); window.C4.__exprWatch = null; return true; },
  // --- 通用 ---
  waitFor: (fn, timeout) => {
    const deadline = Date.now() + (timeout || 6000);
    return new Promise(function (resolve) {
      const timer = setInterval(function () {
        if (fn() || Date.now() > deadline) { clearInterval(timer); resolve(fn()); }
      }, 40);
    });
  },
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

const problems: string[] = []
async function openPage(label: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label}][error] ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`[${label}][pageerror] ${error.message}`))
  await page.goto(BASE, { waitUntil: 'load' })
  await page.evaluate(HELPERS)
  await page.waitForTimeout(1300)
  return page
}

async function idle(page: Page, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const busy = await page.evaluate('window.C4.state().busy')
    if (!busy) return
    await page.waitForTimeout(70)
  }
}

async function scenario(page: Page, stones: string, options = '{}'): Promise<void> {
  await idle(page)
  await page.evaluate(`window.C4.scenario(${stones}, ${options})`)
  await page.waitForTimeout(200)
}

/** 双方交替落子，返回用掉了几手（用于烈焰计时）。 */
async function playHandovers(page: Page, moves: number[], maxHandovers: number): Promise<number> {
  let used = 0
  for (const cell of moves) {
    if (used >= maxHandovers) break
    await page.evaluate(`window.C4.pickStart(${cell})`)
    await idle(page)
    await page.waitForTimeout(90)
    used += 1
    const flames = (await page.evaluate('window.C4.state().flames')) as number
    if (flames === 0) break
  }
  return used
}

const page = await openPage('A')

// ===========================================================================
// #1 恶龙吐息的烈焰 6 回合后熄灭（不再"永远烧下去"）
// ===========================================================================
{
  await scenario(page, '[]', "{ hp: [6,6], current: 0, characters: ['gtp','deepseek'] }")
  // 开局就能放（#6 的顺带验证），直接选目标格
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(220)
  const select = (await page.evaluate('window.C4.state()')) as { skillSelect: { stage: string; need: number } | null }
  await page.evaluate(`window.C4.pickStart(window.C4.cell(4, 4))`)
  await idle(page)
  await page.waitForTimeout(1200)
  const ignited = (await page.evaluate('window.C4.state()')) as { flames: number; uiFlames: number; turnNo: number }
  const sceneFlames = (await page.evaluate('window.C4.flameScene()')) as number[]
  await page.screenshot({ path: `${OUT}/01-flames-ignited.png` })
  check(
    '#1 恶龙吐息点燃整行整列（引擎 / 界面 / 3D 三层都有火）',
    select.skillSelect?.stage === 'cell' &&
      ignited.flames > 0 &&
      ignited.uiFlames === ignited.flames &&
      sceneFlames.length === ignited.flames,
    { select, ignited, sceneFlames: sceneFlames.length },
  )

  // 双方交替落子：12 个半回合 = 双方各走 6 步
  const moves: number[] = []
  for (const col of [0, 1, 2, 3, 5, 6, 7, 8]) moves.push(col)
  for (const col of [0, 1, 2, 3, 5, 6, 7]) moves.push(col)
  const cells = moves.map((col, index) => (index < 8 ? 8 * 9 + col : 7 * 9 + col))
  const used = await playHandovers(page, cells, 15)
  await page.waitForTimeout(700)
  const after = (await page.evaluate('window.C4.state()')) as { flames: number; uiFlames: number }
  const sceneAfter = (await page.evaluate('window.C4.flameScene()')) as number[]
  await page.screenshot({ path: `${OUT}/01-flames-out.png` })
  check(
    '#1 烈焰在 6 个回合（12 个半回合）内全部熄灭：引擎、界面与 3D 都不再残留火',
    used <= 12 && after.flames === 0 && after.uiFlames === 0 && sceneAfter.length === 0,
    { used, after, sceneAfter: sceneAfter.length },
  )
}

// ===========================================================================
// #2 使用技能后技能框高亮 + 流光（对手也看得见）
// ===========================================================================
{
  await scenario(
    page,
    '[]',
    "{ hp: [6,6], current: 0, characters: ['gtp','deepseek'], skillCasts: [[1, 1, 1]] }",
  )
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(240)
  const beforeUse = (await page.evaluate('window.C4.skillDom(0)')) as Array<{ flash: boolean }>
  await page.screenshot({ path: `${OUT}/02-skill-before.png` })
  await page.evaluate(`window.C4.pickStart(window.C4.cell(2, 2))`)
  await idle(page)
  await page.waitForTimeout(260)
  const during = (await page.evaluate('window.C4.skillDom(0)')) as Array<{
    skill: string
    flash: boolean
    flashKey: string | null
    flashLayer: boolean
    flashAnimation: string | null
    slotAnimation: string
  }>
  const flash = (await page.evaluate('window.C4.state()')) as { skillFlash: { player: number; slot: number; key: number } | null }
  const other = (await page.evaluate('window.C4.skillDom(1)')) as Array<{ flash: boolean }>
  await page.screenshot({ path: `${OUT}/02-skill-flash.png` })
  const flashed = during.find((slot) => slot.skill === 'gt-fireball')
  check(
    '#2 释放技能后技能框进入高亮 + 流光状态（自己的槽位亮起，对手槽位不受影响）',
    beforeUse.every((slot) => !slot.flash) &&
      flash.skillFlash?.player === 0 &&
      flash.skillFlash?.slot === 1 &&
      flashed?.flash === true &&
      flashed?.flashLayer === true &&
      (flashed?.flashAnimation ?? '').includes('skillSlotSweep') &&
      (flashed?.slotAnimation ?? '').includes('skillSlotPulse') &&
      other.every((slot) => !slot.flash),
    { flash, during: during.map((slot) => ({ skill: slot.skill, flash: slot.flash, layer: slot.flashLayer, anim: slot.flashAnimation, slotAnim: slot.slotAnimation })), other },
  )

  // 一段时间后自动收掉
  await page.waitForTimeout(2900)
  const later = (await page.evaluate('window.C4.state()')) as { skillFlash: unknown }
  const laterDom = (await page.evaluate('window.C4.skillDom(0)')) as Array<{ flash: boolean }>
  check(
    '#2 流光只持续一段时间，之后自动收掉（不会一直亮着）',
    later.skillFlash === null && laterDom.every((slot) => !slot.flash),
    { later: later.skillFlash, laterDom: laterDom.map((slot) => slot.flash) },
  )
}

// ===========================================================================
// #3 技能气泡：点泡泡外面也要能关掉
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,1],[0,0,2]]',
    "{ hp: [6,6], current: 0, characters: ['deepseek','gemini'] }",
  )
  // 冷却中也能点开气泡（看详情）
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(260)
  const opened = (await page.evaluate('window.C4.bubbleText()')) as string | null
  const openedState = (await page.evaluate('window.C4.state()')) as { skillBubble: unknown }
  await page.screenshot({ path: `${OUT}/03-bubble-open.png` })

  // 点棋盘（画布）空白处 → 关掉
  const rect = (await page.evaluate(
    "(() => { const r = document.getElementById('board-canvas').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height - 40 }; })()",
  )) as { x: number; y: number }
  await page.mouse.click(rect.x, rect.y)
  await page.waitForTimeout(260)
  const closedState = (await page.evaluate('window.C4.state()')) as { skillBubble: unknown }
  check(
    '#3 点技能打开详情气泡，点棋盘空白处（泡泡外面）即可关闭',
    opened !== null && opened.includes('大胃袋') && openedState.skillBubble !== null && closedState.skillBubble === null,
    { opened: opened?.slice(0, 40), closed: closedState.skillBubble },
  )

  // 再打开一次：点泡泡**里面**不能关
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(240)
  const bubbleBox = (await page.evaluate(
    "(() => { const b = document.querySelector('.skill-bubble').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()",
  )) as { x: number; y: number }
  await page.mouse.click(bubbleBox.x, bubbleBox.y)
  await page.waitForTimeout(240)
  const stillOpen = (await page.evaluate('window.C4.state()')) as { skillBubble: unknown }
  // 点画面正中（HUD 之外的空白处）→ 关闭
  await page.mouse.click(720, 450)
  await page.waitForTimeout(240)
  const closedAgain = (await page.evaluate('window.C4.state()')) as { skillBubble: unknown }
  check(
    '#3 点气泡内部不会关闭；点画面其它任意位置都会关闭气泡',
    stillOpen.skillBubble !== null && closedAgain.skillBubble === null,
    { stillOpen: stillOpen.skillBubble, closedAgain: closedAgain.skillBubble },
  )
}

// ===========================================================================
// #4 魔力植物按部位分色（每块纯色，不再叠层混色）
// ===========================================================================
{
  await scenario(page, '[[4,4,1]]', '{ hp: [6,6], current: 0 }')
  const shapes = (await page.evaluate(`(function () {
    const out = {};
    ['flower', 'grass', 'fern'].forEach(function (kind) {
      window.__CONNECT4__.scene.value.magic.despawn(40);
      window.__CONNECT4__.scene.value.magic.spawn(40, kind, null, false);
      out[kind] = window.C4.plantColors(40);
    });
    // 棋盘上同时摆三株（截图用）
    [[20, 'flower'], [40, 'grass'], [60, 'fern']].forEach(function (entry) {
      window.__CONNECT4__.scene.value.magic.spawn(entry[0], entry[1], null, false);
    });
    return out;
  })()`)) as Record<
    string,
    {
      meshColors: string[]
      opacity: number[]
      transparent: boolean[]
      names: string[]
      parts: { leaves: number; stems: number; maxLeafGap: number; bend: number }
    }
  >
  const palette = ['#8a5a33', '#f0c247', '#f2f6fd', '#4f9d5d']
  /** 部位 → 颜色（bugv11 #4 的分配表：枝干褐 / 叶绿 / 花心黄 / 草穗银白）。 */
  const partColor: Record<string, string> = {
    'plant-part-base': '#8a5a33',
    'plant-part-green': '#4f9d5d',
    'plant-part-inner': '#f0c247',
    'plant-part-outer': '#f2f6fd',
  }
  const shapesList = Object.values(shapes)
  const perPartColor = shapesList.every(
    (shape) =>
      shape.meshColors.length > 0 &&
      shape.meshColors.length <= 4 &&
      shape.meshColors.every((color) => palette.includes(color)) &&
      shape.opacity.every((value) => value === 1) &&
      shape.transparent.every((value) => value === false) &&
      shape.names.every((name, index) => partColor[name] === shape.meshColors[index]),
  )
  const allColors = new Set(shapesList.flatMap((shape) => shape.meshColors))
  const distinct = shapesList.map((shape) => new Set(shape.meshColors).size)
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/04-plants.png` })
  check(
    '#4 魔力植物按部位分色：每个部位一块纯色（枝干褐 / 叶片绿 / 花心黄 / 花瓣银白），四色都用到、无半透明叠层',
    perPartColor && allColors.size === 4 && distinct.every((count) => count >= 2),
    {
      parts: Object.fromEntries(
        Object.entries(shapes).map(([kind, shape]) => [kind, shape.names.map((name, i) => `${name}=${shape.meshColors[i]}`)]),
      ),
      opacity: shapes.flower.opacity,
      paletteUsed: [...allColors],
    },
  )
}

// ===========================================================================
// #5 双子星：本回合两连即可发起攻击 + 免疫反击伤害
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,2],[8,0,1]]',
    "{ hp: [6,6], current: 1, characters: ['deepseek','gemini'], skillReady: [[1,1]], " +
      "magic: [{ cell: 70, kind: 'flower', owner: 1 }, { cell: 60, kind: 'grass', owner: 1 }] }",
  )
  await page.evaluate('window.C4.toggleSkill(1, 1)')
  await page.waitForTimeout(220)
  await page.evaluate(`window.C4.pickStart(window.C4.cell(7, 7))`)
  await page.waitForTimeout(160)
  await page.evaluate(`window.C4.pickStart(window.C4.cell(6, 6))`)
  await idle(page)
  await page.waitForTimeout(400)
  const armed = (await page.evaluate('window.C4.state()')) as { twinStar: boolean[]; magicCount: number }
  // 落一颗子形成"两连"（(4,4) 已有自己的子）
  await page.evaluate(`window.C4.pickStart(window.C4.cell(4, 5))`)
  await idle(page)
  await page.waitForTimeout(400)
  const attacked = (await page.evaluate('window.C4.state()')) as {
    phase: string
    highlightOwner: number | null
    twinStar: boolean[]
    magicCount: number
  }
  const snap = (await page.evaluate('window.C4.snap()')) as { attacker: number; baseDamage: number; finalAttack: number }
  await page.screenshot({ path: `${OUT}/05-two-in-a-row.png` })
  check(
    '#5 双子星：本回合只要形成两连就直接进入攻击阶段（两连 = 2 颗攻击棋子，且不再附带植物加成）',
    armed.twinStar[1] === true &&
      armed.magicCount === 0 &&
      attacked.phase === 'awaitingDefense' &&
      attacked.highlightOwner === 1 &&
      snap.attacker === 1 &&
      snap.baseDamage === 2 &&
      snap.finalAttack === 2,
    { armed, attacked, snap },
  )

  // 给防守方摆一个 5 连（反击值 5 > 攻击值），正常会打伤攻击方 —— 双子星免掉
  await page.evaluate(`(function () {
    const engine = window.__CONNECT4__.engine.value;
    engine.board[window.C4.cell(0, 0)] = 1;
    engine.board[window.C4.cell(0, 1)] = 1;
    engine.board[window.C4.cell(0, 2)] = 1;
    engine.board[window.C4.cell(0, 3)] = 1;
    engine.board[window.C4.cell(0, 4)] = 1;
    window.__CONNECT4__.scene.value.syncBoard(engine.board);
    return true;
  })()`)
  await page.evaluate(`window.C4.pickStart(window.C4.cell(3, 3))`)
  await idle(page)
  await page.waitForTimeout(600)
  const resolved = (await page.evaluate('window.C4.snap()')) as {
    mode: string
    damaged: number | null
    defenderAttack: number
    finalAttack: number
  }
  const hp = (await page.evaluate('window.C4.hp()')) as number[]
  check(
    '#5 双子星这一击免疫对手的反击伤害（反击更强也打不动攻击方）',
    resolved.defenderAttack > resolved.finalAttack &&
      resolved.damaged === 1 &&
      resolved.mode === 'immune' &&
      hp[1] === 6,
    { resolved, hp },
  )
  // 爆发窗口用完就关掉
  const closed = (await page.evaluate('window.C4.state()')) as { twinStar: boolean[] }
  check('#5 攻击结算后双子星的爆发窗口自动关闭（仅限当前回合）', closed.twinStar[1] === false, closed.twinStar)
}

// ===========================================================================
// #6 恶龙吐息：开局不进入冷却 + 首次释放无需消耗
// ===========================================================================
{
  await scenario(page, '[]', "{ hp: [6,6], current: 0, characters: ['gtp','deepseek'] }")
  const start = (await page.evaluate('window.C4.skills(0)')) as Array<{
    id: string
    ready: boolean
    remaining: number
    cost: number
    costNow: number
    freeNow: boolean
  }>
  const fireball = start.find((skill) => skill.id === 'gt-fireball')
  const domBefore = (await page.evaluate('window.C4.skillDom(0)')) as Array<{ skill: string; costText: string; stateText: string }>
  const fireballDom = domBefore.find((slot) => slot.skill === 'gt-fireball')
  await page.screenshot({ path: `${OUT}/06-fireball-free.png` })
  check(
    '#6 恶龙吐息开局即可用（不在冷却中）且显示"首次免费 / 0 消耗"',
    fireball?.ready === true &&
      fireball?.remaining === 0 &&
      fireball?.cost === 3 &&
      fireball?.costNow === 0 &&
      fireball?.freeNow === true &&
      (fireballDom?.costText ?? '').includes('免费') &&
      (fireballDom?.stateText ?? '').includes('首次免费'),
    { fireball, fireballDom },
  )

  // 一颗植物都没有也能释放，而且是"不挑植物、直接点目标"
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(200)
  const select = (await page.evaluate('window.C4.state()')) as { skillSelect: { stage: string; need: number } | null }
  await page.evaluate(`window.C4.pickStart(window.C4.cell(4, 4))`)
  await idle(page)
  await page.waitForTimeout(400)
  const after = (await page.evaluate('window.C4.skills(0)')) as Array<{ id: string; costNow: number; remaining: number }>
  const afterState = (await page.evaluate('window.C4.state()')) as { flames: number; magicCount: number; skillCasts: number[][] }
  const secondFireball = after.find((skill) => skill.id === 'gt-fireball')
  check(
    '#6 首次释放不消耗魔力植物（直接进入选目标阶段，0 棵植物也能放），之后按 3 棵收费并进入冷却',
    select.skillSelect?.stage === 'cell' &&
      select.skillSelect?.need === 0 &&
      afterState.flames > 0 &&
      afterState.magicCount === 0 &&
      afterState.skillCasts[0][1] === 1 &&
      secondFireball?.costNow === 3 &&
      secondFireball?.remaining === 12,
    { select, afterState, secondFireball },
  )
}

// ===========================================================================
// #7 攻击阶段立绘保持 atk，攻击结束回默认
// ===========================================================================
{
  await scenario(
    page,
    '[[8,0,1],[8,1,1],[8,2,1],[4,4,2],[5,4,2],[6,4,2]]',
    '{ hp: [6,6], current: 0 }',
  )
  // 攻击方成线 → atk
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 3))`)
  await idle(page)
  await page.waitForTimeout(500)
  const attacking = (await page.evaluate('window.C4.state()')) as { phase: string; expression: string[] }
  const exprDom = (await page.evaluate('window.C4.expressions()')) as string[]
  await page.screenshot({ path: `${OUT}/07-attack-atk.png` })

  // 防守方补一颗成线（对撞 4 : 4）—— 过程中攻击方不能掉回默认
  await page.evaluate('window.C4.watchExpressions()')
  await page.evaluate(`window.C4.pickStart(window.C4.cell(3, 4))`)
  await idle(page)
  await page.waitForTimeout(700)
  const log = (await page.evaluate('window.C4.exprLog()')) as string[]
  await page.evaluate('window.C4.stopWatch()')
  const final = (await page.evaluate('window.C4.state()')) as { expression: string[]; hp: number[] }
  await page.screenshot({ path: `${OUT}/07-after-clash.png` })
  check(
    '#7 攻击阶段攻击方保持 atk，防守方成线时不会被顶回默认（观察到的序列里没有"我方 idle + 对方 atk"）',
    attacking.phase === 'awaitingDefense' &&
      attacking.expression[0] === 'atk' &&
      exprDom[0] === 'atk' &&
      log.includes('atk|idle') &&
      !log.includes('idle|atk'),
    { attacking, exprDom, log },
  )
  check(
    '#7 攻击状态结束后立绘回到默认（对撞打平不再退回 atk）',
    final.expression[0] === 'idle' && final.expression[1] === 'idle' && final.hp[0] === 6 && final.hp[1] === 6,
    { final, last: log[log.length - 1] },
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const passed = results.filter((item) => item.ok).length
console.log(`\n通过 ${passed}/${results.length}`)
if (problems.length > 0) {
  console.log(`\n控制台问题 ${problems.length} 条：`)
  for (const problem of problems.slice(0, 12)) console.log(`  ${problem}`)
}
check('控制台无报错', problems.length === 0, { problems: problems.length })

await browser.close()
process.exit(results.every((item) => item.ok) ? 0 : 1)
