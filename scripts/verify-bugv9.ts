/**
 * bugv9 逐条验证。
 *
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv9.ts
 *
 * #1 对撞位置随机 + 弧线轨道 · #2 魔力植物大改（尺寸 / 三色 / 特征色外覆 / 荧光 / 随机化 /
 * 立刻消失 / 爆风 / 魔法阵）· #3 "2+1 中间空一格"的预判线 · #4 攻击阶段棋盘双特征色循环 ·
 * #5 太阳光束长度形状角度不一 · #6 悬浮棋子数量与总攻击数一致 · #7 右下角微型播放器 ·
 * #8 返回主菜单要关掉菜单 · #9 回放（右下角 / 特效 / 血条 / 跳步关动画 / 导出导入代码）·
 * #10 程序化音效库 + 按扳机选择 · #11 结束炸飞动画 · #12 魔法阵颜色由特征色决定 ·
 * #13 角色系统（立绘 / 表情 / 技能 / 图标 / 护盾 / 双动 / 绽放）
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv9'
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
    // 直接改 ui.mode 不会走 setMode，这里手动对齐"哪几方是 AI"（技能只允许人类那方用）
    if (game.ui.mode === 'pvp' || game.ui.mode === 'online') {
      game.players[0].isAi = false;
      game.players[1].isAi = false;
    } else if (game.ui.mode === 'pve') {
      game.players[0].isAi = false;
      game.players[1].isAi = true;
    } else {
      game.players[0].isAi = true;
      game.players[1].isAi = true;
    }
    // 用 loadScenario 摆局面时不会走 startMatch：手动清掉上面积累的录像与结算状态
    if (game.resetRecording) game.resetRecording();
    game.ui.showResult = false;
    game.ui.result = null;
    game.ui.notice = null;
    game.ui.skillSelect = null;
    const scene = game.scene.value;
    scene.resetTransient();
    scene.setSkillSelecting(null);
    const board = new Array(81).fill(0);
    stones.forEach(function (entry) { board[entry[0] * 9 + entry[1]] = entry[2]; });
    game.engine.value.loadScenario(board, {
      hp: opts.hp || [6, 6],
      current: opts.current === undefined ? 0 : opts.current,
      firstPlayer: opts.current === undefined ? 0 : opts.current,
      magic: opts.magic || [],
      magicGrowths: opts.magicGrowths || 0,
      magicCooldown: opts.magicCooldown === undefined ? 10 : opts.magicCooldown,
      magicLineSeen: Boolean(opts.magicLineSeen),
      shield: opts.shield || [0, 0],
      bonusActions: opts.bonusActions || [0, 0],
      lastPlacedBy: opts.lastPlacedBy || [null, null],
    });
    scene.setIdle(false);
    scene.setInteractive(true);
    scene.syncBoard(board);
    scene.syncMagic(Array.from(game.engine.value.magic.values()));
    game.syncUi();
    return game.engine.value.phase;
  },
  pick: (cell) => window.__CONNECT4__.handleCellPick(cell),
  pickStart: (cell) => { void window.__CONNECT4__.handleCellPick(cell); return true; },
  idle: () => !window.__CONNECT4__.ui.busy,
  state: () => {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    return { screen: game.ui.screen, busy: game.ui.busy, phase: engine.phase, uiPhase: game.ui.phase,
      magicCount: game.ui.magicCount, showResult: game.ui.showResult, shield: [...game.ui.shield],
      result: game.ui.result, menuOpen: game.ui.showGameMenu, settingsOpen: game.ui.showSettings,
      skillSelect: game.ui.skillSelect ? { player: game.ui.skillSelect.player, slot: game.ui.skillSelect.slot, picked: game.ui.skillSelect.picked.length, need: game.ui.skillSelect.need } : null,
      mode: game.ui.mode, locked: document.querySelector('#board-canvas').classList.contains('is-locked') };
  },
  hp: () => window.__CONNECT4__.engine.value.hp.slice(),
  board: () => window.__CONNECT4__.ui.board.slice(),
  snap: () => JSON.parse(JSON.stringify(window.__CONNECT4__.engine.value.attack)),
  // --- #1 对撞 ---
  spyClash: () => {
    const s = window.__CONNECT4__.scene.value;
    if (!s.__clashSpy) {
      s.__clashSpy = [];
      const original = s.runClash.bind(s);
      s.runClash = function (left, right, point, index) {
        s.__clashSpy.push({ point: [point.x, point.y, point.z], ndc: s.lastClashNdc, track: s.lastClashTrack });
        return original(left, right, point, index);
      };
    }
    return true;
  },
  clashes: () => (window.__CONNECT4__.scene.value.__clashSpy || []).slice(),
  clearClashes: () => { window.__CONNECT4__.scene.value.__clashSpy = []; return true; },
  // --- #2 魔力植物 ---
  plants: () => Array.from(window.__CONNECT4__.engine.value.magic.values()).map(function (p) { return { cell: p.cell, kind: p.kind, owner: p.owner }; }),
  plant3d: (cell) => {
    const record = window.__CONNECT4__.scene.value.magic.at(cell);
    if (!record) return null;
    let meshes = 0; const colors = [];
    record.plant.traverse(function (o) {
      if (o.isMesh && o.material && o.material.color) { meshes += 1; colors.push('#' + o.material.color.getHexString()); }
    });
    const fireflies = record.fireflies.map(function (f) {
      return [Number(f.mesh.position.x.toFixed(3)), Number(f.mesh.position.y.toFixed(3)), Number(f.mesh.position.z.toFixed(3))];
    });
    return { owner: record.owner, scale: Number(record.root.scale.x.toFixed(3)),
      sway: Number(record.root.rotation.z.toFixed(4)), meshes: meshes, colors: colors,
      auraVisible: record.aura.visible, auraColor: '#' + record.auraMaterial.color.getHexString(),
      circleVisible: record.ring.visible, circleColor: '#' + record.ring.material.color.getHexString(),
      circleRot: Number(record.ring.rotation.z.toFixed(3)),
      fireflies: fireflies.length, fireflyPos: fireflies };
  },
  spawnPlant: (cell, kind) => { window.__CONNECT4__.scene.value.magic.spawn(cell, kind, null, false); return true; },
  meshShape: (cell) => {
    const record = window.__CONNECT4__.scene.value.magic.at(cell);
    if (!record) return null;
    let petals = 0; let total = 0; let triangles = 0;
    record.plant.traverse(function (o) {
      if (!o.isMesh) return;
      total += 1;
      const index = o.geometry.getIndex();
      triangles += index ? index.count / 3 : 0;
    });
    const head = record.plant.children.find(function (c) { return c.type === 'Group'; });
    if (head) petals = head.children.length;
    // bugv10 追加 #3 之后几何被合并成固定的 4 层，因此"形状随机"改看三角形数量
    return { total: total, triangles: triangles, petals: petals, sway: Number(record.root.rotation.z.toFixed(4)) };
  },
  blast: (x, y, z, strength) => { window.__CONNECT4__.scene.value.magic.blast(new (window.__THREE_VECTOR3__)(x, y, z), strength); return true; },
  // --- #3 预判线 ---
  beams: () => {
    const effects = window.__CONNECT4__.scene.value.effects;
    const rings = window.__CONNECT4__.scene.value.effects.rings;
    return { beams: (effects.beams || []).length, beacons: (rings || []).length };
  },
  // --- #4 棋盘配色 ---
  boardColor: () => {
    const board = window.__CONNECT4__.scene.value.board;
    return { color: '#' + board.attackColorCurrent.toString(16).padStart(6, '0'),
      phase: Number(board.attackPhase.toFixed(3)), mix: Number(board.attackAmount.toFixed(3)) };
  },
  // --- #5 太阳贴图 ---
  sunTexture: () => {
    const texture = window.__CONNECT4__.scene.value.effects.sunTexture;
    if (!texture || !texture.image) return null;
    const canvas = texture.image;
    const context = canvas.getContext('2d');
    const size = canvas.width;
    const data = context.getImageData(0, 0, size, size).data;
    const bins = new Array(72).fill(0);
    let painted = 0;
    const center = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * 4 + 3] > 24) {
          painted += 1;
          const dx = x - center; const dy = y - center;
          let a = Math.atan2(dy, dx); if (a < 0) a += Math.PI * 2;
          const bin = Math.min(71, Math.floor((a / (Math.PI * 2)) * 72));
          const r = Math.hypot(dx, dy);
          if (r > bins[bin]) bins[bin] = r;
        }
      }
    }
    const used = bins.filter(function (v) { return v > 0; });
    return { painted: painted, rays: used.length, min: Math.round(Math.min.apply(null, used)),
      max: Math.round(Math.max.apply(null, used)), distinct: new Set(used.map(function (v) { return Math.round(v / 4); })).size };
  },
  // --- #6 悬浮棋子数 ---
  stage: () => {
    const scene = window.__CONNECT4__.scene.value;
    return { owner0: scene.stageCount(0), owner1: scene.stageCount(1), tally: [...window.__CONNECT4__.ui.tally] };
  },
  // --- #7 播放器 ---
  player: () => {
    const game = window.__CONNECT4__;
    const panel = document.querySelector('.mini-player__panel');
    return { open: !!panel, playing: game.bgmState.playing, muted: game.bgmState.muted,
      volume: Number(game.bgmState.volume.toFixed(2)), index: game.bgmState.index,
      label: (document.querySelector('.mini-player__name') || {}).textContent || null,
      track: game.bgmCurrent && game.bgmCurrent.value ? game.bgmCurrent.value.name : null,
      src: (game.bgm.currentSource || '').split('/').pop() };
  },
  clickPlayer: (selector) => { const el = document.querySelector(selector); if (!el) return false; el.click(); return true; },
  clickByText: (selector, text) => {
    const list = Array.from(document.querySelectorAll(selector));
    const hit = list.find(function (el) { return (el.textContent || '').indexOf(text) >= 0; });
    if (!hit) return false;
    hit.click();
    return true;
  },
  setVolume: (value) => { const input = document.querySelector('.mini-player__range');
    if (!input) return false;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true; },
  // --- #8 菜单 ---
  menuDom: () => ({ overlay: !!document.querySelector('.overlay--menu'), screen: window.__CONNECT4__.ui.screen }),
  clickMenuButton: (index) => {
    const buttons = document.querySelectorAll('.game-menu__actions .menu-btn');
    if (!buttons[index]) return false;
    buttons[index].click();
    return true;
  },
  templateClick: (selector) => { const el = document.querySelector(selector); if (!el) return false; el.click(); return true; },
  // --- #9 回放 ---
  replay: () => {
    const game = window.__CONNECT4__;
    const element = document.querySelector('[data-replay-panel]');
    const rect = element ? element.getBoundingClientRect() : null;
    return { index: game.replay.index, total: game.replay.total, playing: game.replay.playing,
      collapsed: game.replay.collapsed, code: game.replay.codeText.length, message: game.replay.codeMessage,
      rect: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) } : null,
      viewport: [window.innerWidth, window.innerHeight],
      hudPanels: document.querySelectorAll('.hud .player-panel').length,
      hpText: Array.from(document.querySelectorAll('.hp-value')).map(function (el) { return el.textContent; }),
      steps: game.replay.record ? game.replay.record.steps.length : 0,
      events: game.replay.record ? game.replay.record.steps.filter(function (s) { return (s.events || []).length > 0; }).length : 0 };
  },
  seek: (index) => window.__CONNECT4__.seekReplay(index),
  playStep: (index) => window.__CONNECT4__.playReplayStep(index),
  playStepStart: (index) => { void window.__CONNECT4__.playReplayStep(index); return true; },
  exportCode: () => window.__CONNECT4__.fillReplayCode(),
  importCode: (code) => window.__CONNECT4__.playReplayCode(code),
  codeText: () => window.__CONNECT4__.replay.codeText,
  openReplay: (index) => { window.__CONNECT4__.openReplay(window.__CONNECT4__.history[index || 0]); return true; },
  effectsNow: () => {
    const scene = window.__CONNECT4__.scene.value;
    return { beams: (scene.effects.beams || []).length, rings: (scene.effects.rings || []).length,
      shards: scene.pieces.shards.length, staged: scene.stageCount(0) + scene.stageCount(1) };
  },
  // --- #10 音效 ---
  sound: () => {
    const game = window.__CONNECT4__;
    const audio = game.scene.value.audio;
    return { triggers: game.soundTriggers.map(function (t) { return { name: t.name, styles: t.styles.length }; }),
      styles: JSON.parse(JSON.stringify(game.soundStyles)),
      placeStyle: audio.styleFor('place'), clashStyle: audio.styleFor('clash') };
  },
  pickStyle: (trigger, style) => window.__CONNECT4__.setSoundStyle(trigger, style),
  resetStyles: () => window.__CONNECT4__.resetSoundStyles(),
  spyPreview: () => {
    const audio = window.__CONNECT4__.scene.value.audio;
    if (!window.__C4_PREVIEW__) {
      window.__C4_PREVIEW__ = [];
      const original = audio.preview.bind(audio);
      audio.preview = function (name, style, variant) { window.__C4_PREVIEW__.push([name, style]); return original(name, style, variant); };
    }
    return true;
  },
  previews: () => (window.__C4_PREVIEW__ || []).slice(),
  styleChips: () => document.querySelectorAll('.sound-style-row .style-chip').length,
  // --- #11 结束炸飞 ---
  flying: () => {
    const pieces = window.__CONNECT4__.scene.value.pieces;
    return { count: pieces.flyingCount, speeds: pieces.flyingSpeeds.map(function (s) { return Number(s.toFixed(2)); }),
      z: (pieces.flyers || []).map(function (f) { return Number(f.mesh.position.z.toFixed(2)); }),
      board: pieces.boardPieces.length };
  },
  // --- #12 魔法阵颜色 ---
  magicCircles: () => {
    const scene = window.__CONNECT4__.scene.value;
    return scene.staged.map(function (item) {
      return item.magic ? { owner: item.owner, color: '#' + item.magic.material.color.getHexString(), rot: Number(item.magic.rotation.z.toFixed(3)) } : null;
    }).filter(Boolean);
  },
  palette: () => window.__CONNECT4__.players.map(function (p) { return '#' + p.palette.color.toString(16).padStart(6, '0'); }),
  crit: () => ({ shield: [...window.__CONNECT4__.ui.shield], bonus: [...window.__CONNECT4__.ui.bonusActions],
    hp: [...window.__CONNECT4__.ui.hp] }),
  // --- #13 角色 ---
  chars: () => {
    const game = window.__CONNECT4__;
    return { ids: [...game.characters], presets: game.colorPresets.map(function (p) { return p.css; }),
      art: game.players.map(function (p) { return { id: p.character, idle: p.art.idle, atk: p.art.atk, hit: p.art.hit, win: p.art.win, lose: p.art.lose }; }),
      palettes: game.players.map(function (p) { return '#' + p.palette.color.toString(16).padStart(6, '0'); }) };
  },
  setChar: (player, id) => { window.__CONNECT4__.setCharacter(player, id); return true; },
  expr: () => [...window.__CONNECT4__.ui.expression],
  hudDom: () => {
    const panels = Array.from(document.querySelectorAll('.hud .player-panel'));
    return { count: panels.length,
      portrait: panels.map(function (p) { const img = p.querySelector('.portrait__art'); return img ? img.getAttribute('src') : null; }),
      expression: panels.map(function (p) { return p.getAttribute('data-expression'); }),
      shields: panels.map(function (p) { return !!p.querySelector('.hp-bar__shield'); }),
      hp: panels.map(function (p) { const el = p.querySelector('.hp-value'); return el ? el.textContent : null; }),
      hasName: !!document.querySelector('.player-panel__name'), hasAvatar: !!document.querySelector('.avatar'),
      hasTag: !!document.querySelector('.player-panel__tag') };
  },
  skillDom: (side) => {
    const bar = document.querySelector('[data-skill-bar="' + side + '"]');
    if (!bar) return null;
    return { disabled: bar.classList.contains('is-disabled'),
      slots: Array.from(bar.querySelectorAll('.skill-slot')).map(function (slot) {
        const img = slot.querySelector('img');
        const cd = slot.querySelector('.skill-slot__cd');
        const pick = slot.querySelector('.skill-slot__pick');
        return { id: slot.getAttribute('data-skill'), cd: cd ? cd.textContent.trim() : null,
          pick: pick ? pick.textContent.trim() : null,
          icon: img ? img.getAttribute('src').slice(0, 15) : null,
          iconLen: img ? img.getAttribute('src').length : 0,
          classes: slot.className };
      }) };
  },
  skillReady: (player, slot) => { window.__CONNECT4__.engine.value.skillReadyAt[player][slot] = 0; window.__CONNECT4__.syncUi(); return true; },
  skills: () => JSON.parse(JSON.stringify(window.__CONNECT4__.ui.skills)),
  addPlant: (cell, owner) => {
    const engine = window.__CONNECT4__.engine.value;
    engine.magic.set(cell, { cell: cell, kind: 'flower', owner: owner });
    engine.board[cell] = owner + 1;
    window.__CONNECT4__.scene.value.syncMagic(Array.from(engine.magic.values()));
    window.__CONNECT4__.syncUi();
    return true;
  },
  toggleSkill: (player, slot) => window.__CONNECT4__.toggleSkill(player, slot),
  cancelSkill: () => window.__CONNECT4__.cancelSkillSelect(),
  setCurrent: (player) => { window.__CONNECT4__.engine.value.current = player; window.__CONNECT4__.syncUi(); return true; },
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

async function idle(page: Page, timeoutMs = 20000): Promise<void> {
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

const page = await openPage('A')
await page.evaluate('window.C4.spyClash()')
await page.evaluate('window.C4.spyPreview()')

// ===========================================================================
// #1 对撞：位置随机浮动（屏幕内）+ 弧线轨道
// ===========================================================================
{
  const points: Array<{ point: number[]; ndc: number[]; track: Record<string, { from: number[]; mid: number[]; to: number[] }> }> = []
  for (let run = 0; run < 3; run++) {
    await page.evaluate('window.C4.clearClashes()')
    // 攻方 0 在上方 3 连、守方 1 在下方 3 连 → 双方各补一颗就成线，必然对撞
    await scenario(
      page,
      '[[0,0,1],[0,1,1],[0,2,1],[2,0,2],[2,1,2],[2,2,2]]',
      "{ hp: [6,6], current: 0 }",
    )
    await page.evaluate(`window.C4.pick(window.C4.cell(0, 3))`)
    await idle(page)
    await page.evaluate(`window.C4.pick(window.C4.cell(2, 3))`)
    await idle(page)
    const clashes = (await page.evaluate('window.C4.clashes()')) as typeof points
    points.push(...clashes)
  }
  const xs = points.map((entry) => entry.ndc[0])
  const ys = points.map((entry) => entry.ndc[1])
  const inScreen = points.every((entry) => Math.abs(entry.ndc[0]) < 0.95 && Math.abs(entry.ndc[1]) < 0.95)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  check(
    '#1 对撞点是随机的（上下左右都在浮动）且始终在屏幕内',
    points.length >= 8 && inScreen && spreadX > 0.15 && spreadY > 0.1,
    { count: points.length, inScreen, spreadX: Number(spreadX.toFixed(3)), spreadY: Number(spreadY.toFixed(3)) },
  )

  // 弧线：中点明显偏离「起点 → 终点」的直线
  const deviations = points
    .map((entry) => entry.track?.left)
    .filter(Boolean)
    .map((track) => {
      const [fx, fy, fz] = track.from
      const [tx, ty, tz] = track.to
      const [mx, my, mz] = track.mid
      const straight = [(fx + tx) / 2, (fy + ty) / 2, (fz + tz) / 2]
      return Math.hypot(mx - straight[0], my - straight[1], mz - straight[2])
    })
  const curved = deviations.filter((value) => value > 0.05).length
  check(
    '#1 棋子沿弧线飞行（不是直线），轨迹各异',
    deviations.length >= 8 && curved === deviations.length && new Set(deviations.map((v) => v.toFixed(2))).size > 2,
    { tracked: deviations.length, curved, sample: deviations.slice(0, 4).map((v) => Number(v.toFixed(3))) },
  )
  await page.screenshot({ path: `${OUT}/01-clash.png` })
}

// ===========================================================================
// #2 魔力植物：更大 / 三色 / 特征色外覆 / 荧光 / 随机化 / 立刻消失 / 爆风 / 魔法阵
// ===========================================================================
{
  await scenario(page, '[[0,0,2]]', "{ hp: [6,6], current: 0, magic: [{ cell: 40, kind: 'flower', owner: null }] }")
  const before = (await page.evaluate('window.C4.plant3d(40)')) as {
    scale: number
    colors: string[]
    meshes: number
    fireflies: number
    fireflyPos: number[][]
    sway: number
  } | null
  await page.waitForTimeout(700)
  // 摆动周期 = 2π/1.35 ≈ 4.65s：采满一个周期才能可靠量出振幅（旧的振幅是 0.05）
  const swaySamples: number[] = []
  const fireflySamples: number[][] = []
  for (let i = 0; i < 26; i++) {
    const sample = (await page.evaluate('window.C4.plant3d(40)')) as { sway: number; fireflyPos: number[][] } | null
    swaySamples.push(sample?.sway ?? 0)
    if (i < 9) fireflySamples.push(sample?.fireflyPos ?? [])
    await page.waitForTimeout(200)
  }
  const distinctColors = new Set(before?.colors ?? [])
  check(
    '#2 魔力植物更大（缩放 ≥ 1.9）且三色嵌套（白 / 黄 / 褐三套材质）',
    (before?.scale ?? 0) >= 1.9 && distinctColors.size >= 3 && (before?.meshes ?? 0) >= 5,
    { scale: before?.scale, colors: [...distinctColors], meshes: before?.meshes },
  )
  const swayPeak = Math.max(...swaySamples.map((value) => Math.abs(value)))
  check(
    '#2 随风摆动幅度更大（一个周期内最大倾角 ≥ 0.10，旧实现只有 0.05）',
    swayPeak >= 0.1,
    { peak: Number(swayPeak.toFixed(3)), samples: swaySamples.length },
  )
  const fireflyMoved =
    (before?.fireflies ?? 0) >= 3 &&
    new Set(fireflySamples.map((positions) => JSON.stringify(positions))).size >= 3
  check('#2 植物周围有萤火虫般的魔力荧光（≥3 颗且在飘动）', fireflyMoved, {
    fireflies: before?.fireflies,
    frames: new Set(fireflySamples.map((positions) => JSON.stringify(positions))).size,
  })

  // 落子占住：外层覆盖特征色 + 下方换成魔法阵
  await page.evaluate(`window.C4.pick(window.C4.cell(4, 4))`)
  await idle(page)
  const claimed = (await page.evaluate('window.C4.plant3d(40)')) as {
    owner: number
    auraVisible: boolean
    auraColor: string
    circleVisible: boolean
    circleColor: string
    circleRot: number
  } | null
  await page.waitForTimeout(320)
  const circle2 = (await page.evaluate('window.C4.plant3d(40)')) as { circleRot: number } | null
  check(
    '#2 有棋子时外层覆盖该方特征色，且下方的圆环改为旋转的双正方形魔法阵',
    claimed?.owner === 0 &&
      claimed?.auraVisible === true &&
      claimed?.auraColor === '#3964fe' &&
      claimed?.circleVisible === true &&
      claimed?.circleColor === '#3964fe' &&
      Math.abs((circle2?.circleRot ?? 0) - (claimed?.circleRot ?? 0)) > 0.05,
    { claimed, rotated: circle2?.circleRot },
  )

  // 形状随机化：同一格上多次生成同一种植物，形状参数不一样（不同格子必然不同）
  const shapes = (await page.evaluate(`(function () {
    const out = [];
    [3, 12, 21, 30, 39, 48, 57, 66].forEach(function (cell) {
      window.C4.scene().magic.despawn(cell);
      window.C4.spawnPlant(cell, 'flower');
      out.push(window.C4.meshShape(cell));
    });
    return out;
  })()`)) as Array<{ total: number; petals: number; sway: number }>
  const totals = shapes.map((shape) => shape.triangles)
  check(
    '#2 形状随机化（枝条角度 / 花瓣数量与分布各不相同 → 烘焙出来的三角形数量不一样）',
    new Set(totals).size >= 3 && shapes.every((shape) => shape.triangles > 40),
    { totals, distinct: new Set(totals).size },
  )

  const grassShapes = (await page.evaluate(`(function () {
    const out = [];
    [5, 14, 23, 32].forEach(function (cell) {
      window.C4.scene().magic.despawn(cell);
      window.C4.spawnPlant(cell, 'grass');
      out.push(window.C4.meshShape(cell));
    });
    return out;
  })()`)) as Array<{ total: number; triangles: number }>
  check(
    '#2 草（3~5 根）与蕨（叶子数量 / 排布随机）的三角形数量各不相同',
    new Set(grassShapes.map((shape) => shape.triangles)).size >= 2,
    { totals: grassShapes.map((shape) => shape.triangles) },
  )
  await page.screenshot({ path: `${OUT}/02-plants.png` })

  // 立即消失：防守方一落子，连珠上的植物马上没了（不用等攻击阶段结束）
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1],[2,3,2],[3,3,2],[4,3,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 12, kind: 'flower', owner: 0 }] }",
  )
  await page.evaluate(`window.C4.pick(window.C4.cell(1, 4))`)
  await idle(page)
  const plantsBeforeDefense = (await page.evaluate('window.C4.plants()')).length
  await page.evaluate(`window.C4.pickStart(window.C4.cell(5, 5))`)
  let goneWhileBusy = false
  for (let i = 0; i < 60; i++) {
    const snapshot = (await page.evaluate('({ busy: window.C4.state().busy, plants: window.C4.plants().length })')) as {
      busy: boolean
      plants: number
    }
    if (snapshot.plants === 0 && snapshot.busy) {
      goneWhileBusy = true
      break
    }
    if (!snapshot.busy) break
    await page.waitForTimeout(60)
  }
  await idle(page)
  check(
    '#2 防守方落子后魔力植物立刻消失（还在播攻击动画时就没了）',
    plantsBeforeDefense === 1 && goneWhileBusy,
    { plantsBeforeDefense, goneWhileBusy },
  )

  // 爆风：对撞 / 撞血条时附近的植物被吹歪
  await scenario(page, '[[0,0,2]]', "{ hp: [6,6], current: 0, magic: [{ cell: 40, kind: 'fern', owner: null }] }")
  const calmSways: number[] = []
  for (let i = 0; i < 6; i++) {
    const sample = (await page.evaluate('window.C4.plant3d(40)')) as { sway: number } | null
    calmSways.push(Math.abs(sample?.sway ?? 0))
    await page.waitForTimeout(40)
  }
  // 爆心稍微偏一点（真实对撞点在棋盘上方，很少正好压在植物根部）
  await page.evaluate('window.C4.blast(0.6, 0.4, 0.6, 1.4)')
  let blastedPeak = 0
  for (let i = 0; i < 14; i++) {
    const sample = (await page.evaluate('window.C4.plant3d(40)')) as { sway: number } | null
    blastedPeak = Math.max(blastedPeak, Math.abs(sample?.sway ?? 0))
    await page.waitForTimeout(30)
  }
  const calmPeak = Math.max(...calmSways)
  check(
    '#2 爆风会吹到魔力植物（被冲击波吹歪的幅度明显超过自然摆动）',
    blastedPeak > calmPeak + 0.05 && blastedPeak > 0.16,
    { calmPeak: Number(calmPeak.toFixed(3)), blastedPeak: Number(blastedPeak.toFixed(3)) },
  )
}

// ===========================================================================
// #3 "2 + 1 中间空一格"也要有预判线
// ===========================================================================
{
  // X X _ X：落子在 (0,3) 之后应该沿横向拉出预判针，并把缺口圈出来
  await scenario(page, '[[0,0,1],[0,1,1]]', "{ hp: [6,6], current: 0 }")
  await page.evaluate(`window.C4.pick(window.C4.cell(0, 3))`)
  await page.waitForTimeout(120)
  const hinted = (await page.evaluate('window.C4.beams()')) as { beams: number; beacons: number }
  check(
    '#3 2+1 中间空一格（X X _ X）也会显示预判线（并圈出要补的那一格）',
    hinted.beams > 0 && hinted.beacons > 0,
    hinted,
  )
  await page.screenshot({ path: `${OUT}/03-threat-hint.png` })
  await idle(page)
}

// ===========================================================================
// #4 攻击阶段棋盘在双方特征色之间循环（0.5 秒一次，有过渡）
// ===========================================================================
{
  await scenario(page, '[[0,0,2],[8,0,1],[8,1,1],[8,2,1]]', '{ hp: [6,6], current: 0 }')
  const before = (await page.evaluate('window.C4.boardColor()')) as { color: string; mix: number }
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  const samples: Array<{ color: string; phase: number; at: number }> = []
  const started = Date.now()
  for (let i = 0; i < 26; i++) {
    const sample = (await page.evaluate('window.C4.boardColor()')) as { color: string; phase: number; mix: number }
    samples.push({ color: sample.color, phase: sample.phase, at: Date.now() - started })
    await page.waitForTimeout(60)
  }
  const colors = new Set(samples.map((sample) => sample.color))
  // 前几帧还在从黑色过渡，跳过它们再看"不再有黑色"
  const settled = samples.slice(6).map((sample) => sample.color)
  const distance = (a: string, b: string): number => {
    const parse = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
    const [r1, g1, b1] = parse(a)
    const [r2, g2, b2] = parse(b)
    return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2))
  }
  const nearA = Math.min(...samples.map((sample) => distance(sample.color, '#3964fe')))
  const nearB = Math.min(...samples.map((sample) => distance(sample.color, '#d45fb9')))
  check(
    '#4 攻击阶段棋盘不再是黑色，而是在双方特征色之间循环（颜色持续变化）',
    before.mix < 0.05 && colors.size > 6 && settled.every((color) => color !== '#1b1e26'),
    { before: before.color, distinct: colors.size, first: samples[0]?.color, last: samples[samples.length - 1]?.color },
  )
  check(
    '#4 循环会到达两方的特征色（两个角色的颜色都到达过）',
    nearA <= 6 && nearB <= 6,
    { nearA, nearB },
  )
  await page.screenshot({ path: `${OUT}/04-board-cycle.png` })
  // 防守方落子结束攻击阶段 → 棋盘回到黑色（浮点阻尼不会精确等于 0，留一点容差）
  await page.evaluate(`window.C4.pick(window.C4.cell(5, 5))`)
  await idle(page)
  await page.waitForTimeout(420)
  const after = (await page.evaluate('window.C4.boardColor()')) as { color: string; mix: number }
  const blackDistance = distance(after.color, '#1b1e26')
  check(
    '#4 攻击状态结束后棋盘回到黑色',
    after.mix < 0.02 && blackDistance <= 3,
    { ...after, blackDistance },
  )
}

// ===========================================================================
// #5 太阳光束：长度 / 形状 / 角度不一
// ===========================================================================
{
  const sun = (await page.evaluate('window.C4.sunTexture()')) as {
    painted: number
    rays: number
    min: number
    max: number
    distinct: number
  } | null
  check(
    '#5 太阳特效的光束长度连续随机（最长 / 最短 ≥ 1.8 倍，且取值多样）',
    (sun?.rays ?? 0) >= 20 && (sun?.max ?? 0) / Math.max(sun?.min ?? 1, 1) >= 1.8 && (sun?.distinct ?? 0) >= 8,
    sun,
  )
  await page.screenshot({ path: `${OUT}/05-sun.png` })
}

// ===========================================================================
// #6 悬浮棋子数量 == 总攻击数（削弱 -N / 魔力植物 +N）
// ===========================================================================
{
  // ① 4 连 + 连珠上 1 棵植物 → 总攻击 5，悬浮也必须是 5
  await scenario(
    page,
    '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 73, kind: 'flower', owner: 0 }] }",
  )
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  const withPlant = (await page.evaluate('window.C4.stage()')) as { owner0: number; owner1: number; tally: number[] }
  check(
    '#6 魔力植物会让总攻击数 +1，舞台上也额外生成 1 颗悬浮棋子（数量一致）',
    withPlant.tally[0] === 5 && withPlant.owner0 === 5,
    withPlant,
  )

  // ② 防守方在高光位（不带植物）落子削弱 1 → 悬浮棋子先变成 4，最终打 4 点
  const hpBeforeWeak = (await page.evaluate('window.C4.hp()')) as number[]
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 2))`)
  let sawFour = false
  for (let i = 0; i < 60; i++) {
    const stage = (await page.evaluate('window.C4.stage()')) as { owner0: number; tally: number[] }
    if (stage.tally[0] === 4 && stage.owner0 === 4) {
      sawFour = true
      break
    }
    await page.waitForTimeout(60)
  }
  await idle(page)
  const hpAfterWeak = (await page.evaluate('window.C4.hp()')) as number[]
  check(
    '#6 防守方削减攻击后，悬浮棋子数量同步减少（4+1-1=4，正好打 4 点）',
    sawFour && hpBeforeWeak[1] - hpAfterWeak[1] === 4,
    { sawFour, hpBefore: hpBeforeWeak, hpAfter: hpAfterWeak },
  )

  // ③ 无植物：4 连被削弱 1 → 悬浮从 4 变 3，且 3 颗全部打到血条（扣 3 点）
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  const beforePick = (await page.evaluate('window.C4.hp()')) as number[]
  const stageBefore = (await page.evaluate('window.C4.stage()')) as { owner0: number; tally: number[] }
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 2))`)
  let sawThree = false
  for (let i = 0; i < 60; i++) {
    const stage = (await page.evaluate('window.C4.stage()')) as { owner0: number; tally: number[] }
    if (stage.tally[0] === 3 && stage.owner0 === 3) {
      sawThree = true
      break
    }
    await page.waitForTimeout(60)
  }
  await idle(page)
  const afterHp = (await page.evaluate('window.C4.hp()')) as number[]
  check(
    '#6 被削弱 1 点时悬浮棋子从 4 变成 3，且 3 颗全部打到血条（扣 3 点）',
    stageBefore.owner0 === 4 && sawThree && beforePick[1] - afterHp[1] === 3,
    { stageBefore, sawThree, hpBefore: beforePick, hpAfter: afterHp },
  )
}

// ===========================================================================
// #7 右下角微型播放器
// ===========================================================================
{
  const closed = (await page.evaluate('window.C4.player()')) as { open: boolean; track: string; src: string; volume: number }
  await page.evaluate(`window.C4.clickPlayer('.mini-player__handle')`)
  await page.waitForTimeout(320)
  const opened = (await page.evaluate('window.C4.player()')) as { open: boolean; label: string; track: string; index: number }
  const handle = (await page.evaluate(`document.querySelector('.mini-player__handle').getAttribute('aria-expanded')`)) as string
  check(
    '#7 点箭头展开微型播放器（含歌名 / 上一首 / 播放暂停 / 下一首 / 音量）',
    closed.open === false &&
      opened.open === true &&
      handle === 'true' &&
      typeof opened.label === 'string' &&
      (opened.label?.length ?? 0) > 0 &&
      !!(await page.evaluate(`!!document.querySelector('.mini-player__range')`)) &&
      !!(await page.evaluate(`document.querySelectorAll('.mini-btn').length >= 4`)),
    { closed: closed.open, opened: opened.open, label: opened.label },
  )
  check(
    '#7 默认播放 let me go.mp3（找不到才播第一首）',
    decodeURIComponent(closed.src).startsWith('let me go') && closed.track === 'let me go',
    { src: decodeURIComponent(closed.src), track: closed.track },
  )

  await page.evaluate(`window.C4.clickPlayer('.mini-btn[title="下一首"]')`)
  await page.waitForTimeout(160)
  const next = (await page.evaluate('window.C4.player()')) as { index: number; track: string }
  await page.evaluate(`window.C4.clickPlayer('.mini-btn[title="上一首"]')`)
  await page.waitForTimeout(160)
  const prev = (await page.evaluate('window.C4.player()')) as { index: number; track: string }
  check(
    '#7 上一首 / 下一首能切歌（并且回到原来那首）',
    next.index !== prev.index && prev.track === 'let me go' && prev.index === closed.index,
    { next, prev },
  )

  await page.evaluate('window.C4.setVolume(35)')
  await page.waitForTimeout(120)
  const volume = (await page.evaluate('window.C4.player()')) as { volume: number }
  await page.evaluate(`window.C4.clickPlayer('.mini-btn--ghost')`)
  await page.waitForTimeout(120)
  const muted = (await page.evaluate('window.C4.player()')) as { muted: boolean }
  check(
    '#7 音量滑块与静音按钮生效',
    Math.abs(volume.volume - 0.35) < 0.02 && muted.muted === true,
    { volume: volume.volume, muted: muted.muted },
  )
  await page.evaluate(`window.C4.clickPlayer('.mini-btn--ghost')`)
  await page.evaluate(`window.C4.clickPlayer('.mini-player__handle')`)
  await page.waitForTimeout(700)
  const collapsed = (await page.evaluate('window.C4.player()')) as { open: boolean }
  check('#7 再点箭头收回播放器', collapsed.open === false, collapsed)
  await page.screenshot({ path: `${OUT}/07-mini-player.png` })
}

// ===========================================================================
// #8 菜单「返回主菜单」要真的关掉菜单
// ===========================================================================
{
  await scenario(page, '[[4,4,1]]', '{ hp: [6,6], current: 0 }')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(260)
  const opened = (await page.evaluate('window.C4.menuDom()')) as { overlay: boolean; screen: string }
  const clicked = (await page.evaluate(`window.C4.clickByText('.game-menu__actions .menu-btn', '返回主菜单')`)) as boolean
  await page.waitForTimeout(700)
  const after = (await page.evaluate('window.C4.menuDom()')) as { overlay: boolean; screen: string }
  const flags = (await page.evaluate('window.C4.state()')) as { menuOpen: boolean; settingsOpen: boolean }
  check(
    '#8 点「返回主菜单」后菜单浮层关闭（之前会一直盖在屏幕上）',
    opened.overlay === true && clicked && after.screen === 'menu' && after.overlay === false &&
      flags.menuOpen === false && flags.settingsOpen === false,
    { opened, after, menuOpen: flags.menuOpen, settingsOpen: flags.settingsOpen },
  )
}

// ===========================================================================
// #9 回放：右下角 / 特效与血条 / 跳步关动画 / 导出导入代码
// ===========================================================================
{
  // 打一局短的：连续几手 → 成线 → 防守漏挡 → 结束（这样回放里有 4 步）
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,1], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(0, 0))`)
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(1, 0))`)
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(5, 5))`)
  await idle(page, 30000)
  const history = (await page.evaluate('window.__CONNECT4__.history.length')) as number
  await page.evaluate('window.C4.openReplay(0)')
  await page.waitForTimeout(420)
  const info = (await page.evaluate('window.C4.replay()')) as {
    rect: { left: number; right: number; top: number; bottom: number; width: number } | null
    viewport: number[]
    hudPanels: number
    total: number
    events: number
    index: number
  }
  const [vw, vh] = info.viewport
  check(
    '#9 回放面板贴在右下角、不挡棋盘中间，并且展开了',
    !!info.rect &&
      info.rect.right > vw * 0.6 &&
      info.rect.left > vw * 0.5 &&
      info.rect.bottom > vh * 0.4 &&
      info.rect.width < vw * 0.4,
    info.rect,
  )
  check(
    '#9 回放时顶部立绘 / 血条与攻击结算面板都在（和真实对局一样）',
    info.hudPanels === 2 && history > 0,
    { hudPanels: info.hudPanels, history, total: info.total },
  )

  // 跳步：先播一步，再拖回开局 → 必须掐掉动画并落到该步
  await page.evaluate('window.C4.playStep(1)')
  await page.waitForTimeout(160)
  await page.evaluate('window.C4.seek(0)')
  await page.waitForTimeout(220)
  const cancel = (await page.evaluate('({ busy: window.C4.state().busy, staged: window.C4.effectsNow().staged, board: window.C4.board().filter(function (c) { return c !== 0; }).length })')) as {
    busy: boolean
    staged: number
    board: number
  }
  check(
    '#9 快进 / 快退会关掉正在播的动画并落到当前步（无残留舞台棋子）',
    cancel.busy === false && cancel.staged === 0 && cancel.board === 0,
    cancel,
  )

  // 逐步播放：连珠要出针状光带，撞击血条要出碎片，血条要跟着掉
  await page.evaluate('window.C4.seek(2)')
  await page.waitForTimeout(140)
  await page.evaluate('window.C4.playStepStart(3)')
  const maxima = { beams: 0, rings: 0, shards: 0 }
  for (let i = 0; i < 70; i++) {
    const fx = (await page.evaluate('window.C4.effectsNow()')) as typeof maxima
    maxima.beams = Math.max(maxima.beams, fx.beams)
    maxima.rings = Math.max(maxima.rings, fx.rings)
    maxima.shards = Math.max(maxima.shards, fx.shards)
    if (maxima.beams > 0 && maxima.rings > 0 && i > 6) break
    await page.waitForTimeout(50)
  }
  await idle(page)
  await page.evaluate('window.C4.seek(3)')
  await page.waitForTimeout(160)
  const stagedInAttack = (await page.evaluate('window.C4.effectsNow()')) as { staged: number }
  await page.evaluate('window.C4.playStepStart(4)')
  for (let i = 0; i < 80; i++) {
    const fx = (await page.evaluate('window.C4.effectsNow()')) as { shards: number }
    maxima.shards = Math.max(maxima.shards, fx.shards)
    if (maxima.shards > 0 && i > 6) break
    await page.waitForTimeout(50)
  }
  await idle(page, 30000)
  const afterPlay = (await page.evaluate('window.C4.replay()')) as { hpText: string[]; index: number }
  check(
    '#9 逐步播放会重播特效（连珠针 / 冲击波 / 撞击血条的碎片）并更新血条',
    maxima.beams > 0 && stagedInAttack.staged > 0 && maxima.shards > 0 && afterPlay.hpText[1] === '-3',
    { maxima, stagedInAttack, hp: afterPlay.hpText },
  )

  // 导出 / 导入代码
  const code = (await page.evaluate('window.C4.exportCode()')) as string
  await page.evaluate('window.__CONNECT4__.clearHistory()')
  const playable = (await page.evaluate(`window.C4.importCode(${JSON.stringify(code.slice(0, 0) + code)})`)) as boolean
  await page.waitForTimeout(360)
  const imported = (await page.evaluate('window.C4.replay()')) as { total: number; events: number; message: string }
  check(
    '#9 可以导出回放代码，复制粘贴后能播放（清空本地存档后依然可播）',
    code.startsWith('C4R1:') &&
      code.length > 400 &&
      playable === true &&
      imported.total === info.total &&
      imported.events >= 1,
    { codeLen: code.length, playable, imported: { total: imported.total, events: imported.events } },
  )
  await page.screenshot({ path: `${OUT}/09-replay.png` })
  await page.evaluate('window.__CONNECT4__.closeReplay()')
  await page.waitForTimeout(320)
}

// ===========================================================================
// #10 程序化音效库 + 按扳机选择（选择时试听）
// ===========================================================================
{
  // 先回到对局里（右下角设置按钮只在游戏内出现）
  await scenario(page, '[[4,4,1]]', '{ hp: [6,6], current: 0 }')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(320)
  await page.evaluate(`window.C4.clickByText('.game-menu__actions .menu-btn', '设置')`)
  await page.waitForTimeout(360)
  await page.evaluate(`window.C4.clickByText('.settings-nav__item', '音频')`)
  await page.waitForTimeout(300)
  const chips = (await page.evaluate('window.C4.styleChips()')) as number
  const sound = (await page.evaluate('window.C4.sound()')) as {
    triggers: Array<{ name: string; styles: number }>
    styles: Record<string, string>
    placeStyle: string
  }
  const enoughStyles = sound.triggers.length >= 9 && sound.triggers.every((trigger) => trigger.styles >= 2)
  check(
    '#10 每个扳机都有多套程序化音效可选（≥9 个扳机、每个 ≥2 套）',
    enoughStyles && chips >= 18,
    { triggers: sound.triggers, chips },
  )

  await page.evaluate(`window.C4.pickStyle('place', 'stone')`)
  await page.waitForTimeout(200)
  const previews = (await page.evaluate('window.C4.previews()')) as Array<[string, string]>
  const after = (await page.evaluate('window.C4.sound()')) as { styles: Record<string, string>; placeStyle: string }
  const stored = (await page.evaluate(`JSON.parse(localStorage.getItem('connect4.sounds.v1') || '{}')`)) as Record<string, string>
  check(
    '#10 选择某个扳机的音效会立即试听并保存（落子 → 石子）',
    after.placeStyle === 'stone' &&
      after.styles.place === 'stone' &&
      stored.place === 'stone' &&
      previews.some((entry) => entry[0] === 'place' && entry[1] === 'stone'),
    { previews: previews.slice(-3), stored: stored.place },
  )
  await page.evaluate('window.C4.resetStyles()')
  await page.waitForTimeout(120)
  const reset = (await page.evaluate('window.C4.sound()')) as { placeStyle: string }
  check('#10 恢复默认后回到木质落子音', reset.placeStyle === 'wood', reset)
  await page.screenshot({ path: `${OUT}/10-sound-styles.png` })
  await page.evaluate(`window.C4.templateClick('.settings-dialog__foot .primary-btn')`)
  await page.waitForTimeout(300)
}

// ===========================================================================
// #11 结束动画：棋子高速炸飞、越来越慢、往玩家方向飞
// ===========================================================================
{
  await scenario(
    page,
    '[[0,0,1],[0,2,1],[0,4,1],[8,0,1],[8,1,1],[8,2,1],[6,4,2]]',
    '{ hp: [6,1], current: 0 }',
  )
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page, 30000)
  // 结束动画在攻击结算之后才播：这里不 await，改成一帧帧地观察
  await page.evaluate(`window.C4.pickStart(window.C4.cell(5, 5))`)
  let early = { count: 0, speeds: [] as number[], z: [] as number[], board: 0 }
  for (let i = 0; i < 200; i++) {
    const flying = (await page.evaluate('window.C4.flying()')) as typeof early
    if (flying.count > 0) {
      early = flying
      break
    }
    await page.waitForTimeout(50)
  }
  const earlyMax = Math.max(...early.speeds, 0)
  await page.waitForTimeout(520)
  const late = (await page.evaluate('window.C4.flying()')) as { count: number; speeds: number[]; z: number[] }
  const lateMax = Math.max(...late.speeds, 0)
  let gone = { count: 1, board: 99 }
  for (let i = 0; i < 60; i++) {
    gone = (await page.evaluate('window.C4.flying()')) as { count: number; board: number }
    if (gone.count === 0) break
    await page.waitForTimeout(80)
  }
  const earlyZ = early.z.reduce((sum, value) => sum + value, 0) / Math.max(early.z.length, 1)
  const lateZ = late.z.reduce((sum, value) => sum + value, 0) / Math.max(late.z.length, 1)
  check(
    '#11 对局结束后棋盘上的棋子全部高速炸飞（初速高、逐渐减速、往 z 轴玩家方向飞、最后离开屏幕）',
    early.count >= 4 && earlyMax > 12 && lateMax < earlyMax && lateZ > earlyZ && gone.count === 0,
    {
      early: early.count,
      earlyMax,
      lateMax,
      earlyZ: Number(earlyZ.toFixed(2)),
      lateZ: Number(lateZ.toFixed(2)),
      gone: gone.count,
    },
  )
  await page.screenshot({ path: `${OUT}/11-gameover.png` })
  await idle(page)
}

// ===========================================================================
// #12 悬浮棋子的魔法阵颜色由特征色决定
// ===========================================================================
{
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await page.waitForTimeout(120)
  await idle(page)
  const before = (await page.evaluate('window.C4.magicCircles()')) as Array<{ owner: number; color: string; rot: number }>
  // 换角色 → 特征色变化 → 魔法阵必须跟着变
  await page.evaluate(`window.C4.setChar(0, 'gemini')`)
  await page.waitForTimeout(220)
  const after = (await page.evaluate('window.C4.magicCircles()')) as Array<{ owner: number; color: string; rot: number }>
  const paletteAfter = (await page.evaluate('window.C4.palette()')) as string[]
  const owner0Before = before.find((item) => item.owner === 0)?.color
  const owner0After = after.find((item) => item.owner === 0)?.color
  check(
    '#12 悬浮棋子的魔法阵颜色 = 该方特征色，并随角色 / 特征色变化',
    before.length > 0 &&
      owner0Before === '#3964fe' &&
      owner0After === '#d45fb9' &&
      owner0After === paletteAfter[0] &&
      Math.abs((before[0]?.rot ?? 0) - (after[0]?.rot ?? 0)) > 0.01,
    { owner0Before, owner0After, palette: paletteAfter[0] },
  )
  await page.evaluate(`window.C4.setChar(0, 'deepseek')`)
  await page.waitForTimeout(200)
  await idle(page)
}

// ===========================================================================
// #13 角色系统
// ===========================================================================
{
  const chars = (await page.evaluate('window.C4.chars()')) as {
    ids: string[]
    presets: string[]
    art: Array<{ id: string; idle: string; atk: string; hit: string; win: string; lose: string }>
    palettes: string[]
  }
  const artOk = chars.art.every((entry) => {
    const list = [entry.idle, entry.atk, entry.hit, entry.win, entry.lose]
    return list.every((url) => typeof url === 'string' && url.length > 0) && new Set(list).size === 5
  })
  check(
    '#13 两个角色各有 5 个表情差分立绘，且特征色（deepseek #3964fe / gemini #d45fb9）加入特征色列表',
    chars.art.length === 2 &&
      artOk &&
      chars.presets.includes('#3964fe') &&
      chars.presets.includes('#d45fb9') &&
      chars.palettes[0] === '#3964fe' &&
      chars.palettes[1] === '#d45fb9',
    { ids: chars.ids, presets: chars.presets.slice(0, 2), artOk },
  )

  // 双方可以选同一个角色
  await page.evaluate(`window.C4.setChar(1, 'deepseek')`)
  await page.waitForTimeout(160)
  const same = (await page.evaluate('window.C4.chars()')) as { ids: string[]; art: Array<{ idle: string }>; palettes: string[] }
  await page.evaluate(`window.C4.setChar(1, 'gemini')`)
  await page.waitForTimeout(160)
  check(
    '#13 双方可以选择同一个角色（立绘与特征色都跟着变）',
    same.ids[0] === 'deepseek' && same.ids[1] === 'deepseek' && same.palettes[0] === same.palettes[1],
    { ids: same.ids, palettes: same.palettes },
  )

  // 顶部只显示立绘 + 血条
  await scenario(page, '[[4,4,1]]', '{ hp: [6,6], current: 0 }')
  await page.waitForTimeout(200)
  const hud = (await page.evaluate('window.C4.hudDom()')) as {
    count: number
    portrait: Array<string | null>
    hasName: boolean
    hasAvatar: boolean
    hasTag: boolean
  }
  check(
    '#13 左右上角只显示角色立绘与血条（移除了头像 / 名字 / 标签）',
    hud.count === 2 &&
      hud.portrait.every((src) => typeof src === 'string' && src.length > 0) &&
      hud.hasName === false &&
      hud.hasAvatar === false &&
      hud.hasTag === false,
    { count: hud.count, hasName: hud.hasName, hasAvatar: hud.hasAvatar, hasTag: hud.hasTag },
  )

  // 技能槽：图标程序化生成、开局冷却中
  const skillDom = (await page.evaluate('window.C4.skillDom(0)')) as {
    slots: Array<{ id: string; cd: string | null; icon: string | null; iconLen: number }>
  } | null
  const skills = (await page.evaluate('window.C4.skills()')) as Array<Array<{ id: string; remaining: number; cost: number }>>
  check(
    '#13 画面左右两侧有技能槽，技能图标程序化生成（PNG data URL），开局处于冷却',
    (skillDom?.slots.length ?? 0) === 2 &&
      skillDom!.slots.every((slot) => (slot.icon ?? '').startsWith('data:image/png') && slot.iconLen > 400) &&
      skillDom!.slots.every((slot) => slot.cd !== null) &&
      skills[0].every((skill) => skill.remaining > 0),
    { slots: skillDom?.slots.map((slot) => ({ id: slot.id, cd: slot.cd, len: slot.iconLen })), cooldowns: skills[0] },
  )
  await page.screenshot({ path: `${OUT}/13-skills.png` })

  // deepseek 护盾：消耗 1 棵植物 → 护盾 1，血条出现银色段
  await scenario(
    page,
    '[[0,0,2],[8,8,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 40, kind: 'flower', owner: 0 }] }",
  )
  await page.evaluate('window.C4.skillReady(0, 0)')
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(200)
  const selecting = (await page.evaluate('window.C4.state()')) as {
    skillSelect: { player: number; slot: number; picked: number; need: number } | null
  }
  const dimmed = (await page.evaluate(`document.querySelector('.app-root').classList.contains('is-dimmed')`)) as boolean
  await page.evaluate(`window.C4.pick(window.C4.cell(4, 4))`)
  await idle(page)
  const shielded = (await page.evaluate('window.C4.crit()')) as { shield: number[] }
  const shieldDom = (await page.evaluate('window.C4.hudDom()')) as { shields: boolean[] }
  const plantsLeft = (await page.evaluate('window.C4.plants()')).length
  check(
    '#13 deepseek 技能①：消耗 1 棵魔力植物 → 获得 1 护盾（银色血条），挑植物时画面变暗并高亮',
    selecting.skillSelect?.slot === 0 &&
      selecting.skillSelect?.need === 1 &&
      dimmed === true &&
      shielded.shield[0] === 1 &&
      shieldDom.shields[0] === true &&
      plantsLeft === 0,
    { selecting: selecting.skillSelect, dimmed, shield: shielded.shield, dom: shieldDom.shields, plantsLeft },
  )
  await page.screenshot({ path: `${OUT}/13-shield.png` })

  // gemini 回血：hp 4 → 5
  await scenario(
    page,
    '[[0,0,1],[8,8,1]]',
    "{ hp: [6,4], current: 1, magic: [{ cell: 40, kind: 'fern', owner: 1 }] }",
  )
  await page.evaluate('window.C4.skillReady(1, 0)')
  await page.evaluate('window.C4.toggleSkill(1, 0)')
  await page.waitForTimeout(160)
  await page.evaluate(`window.C4.pick(window.C4.cell(4, 4))`)
  await idle(page)
  const healed = (await page.evaluate('window.C4.hp()')) as number[]
  check('#13 gemini 技能①：消耗 1 棵植物恢复 1 点血量', healed[1] === 5, healed)

  // gemini 双子星（bugv10 追加 #6：先挂上标记，下一颗棋子落下时才绽放）
  await scenario(
    page,
    '[[0,0,2],[0,2,2],[0,4,2]]',
    "{ hp: [6,6], current: 1, magic: [{ cell: 80, kind: 'grass', owner: 1 }, { cell: 78, kind: 'grass', owner: 1 }, { cell: 62, kind: 'grass', owner: 1 }] }",
  )
  await page.evaluate('window.C4.skillReady(1, 1)')
  await page.evaluate('window.C4.toggleSkill(1, 1)')
  await page.waitForTimeout(180)
  const need = (await page.evaluate('window.C4.state()')) as { skillSelect: { need: number; picked: number } | null }
  // bugv10 #3：双子星的消耗从 3 改成 2
  for (const cell of [80, 78]) {
    await page.evaluate(`window.C4.pick(${cell})`)
    await page.waitForTimeout(120)
  }
  await idle(page)
  // 技能已就绪 → 再落一颗子，这一格与周围都长出植物
  await page.evaluate(`window.C4.pick(window.C4.cell(4, 4))`)
  await idle(page)
  const bloomed = (await page.evaluate('window.C4.plants()')) as Array<{ cell: number; owner: number | null }>
  const around = [30, 31, 32, 39, 40, 41, 48, 49, 50]
  const grown = bloomed.filter((plant) => around.includes(plant.cell))
  check(
    '#13 gemini 技能②：消耗 2 棵植物（bugv10 #3），下一颗棋子落下时它自己与周围全部长出魔力植物',
    need.skillSelect?.need === 2 && grown.length >= 6 && grown.some((plant) => plant.cell === 40),
    { need: need.skillSelect, grown: grown.length, cells: grown.map((plant) => plant.cell) },
  )
  await page.screenshot({ path: `${OUT}/13-bloom.png` })

  // deepseek 连续行动
  await scenario(
    page,
    '[[0,0,2],[8,8,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 2, kind: 'flower', owner: 0 }, { cell: 4, kind: 'flower', owner: 0 }, { cell: 6, kind: 'flower', owner: 0 }, { cell: 20, kind: 'flower', owner: 0 }, { cell: 22, kind: 'flower', owner: 0 }] }",
  )
  await page.evaluate('window.C4.skillReady(0, 1)')
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(180)
  for (const cell of [2, 4, 6]) {
    await page.evaluate(`window.C4.pick(${cell})`)
    await page.waitForTimeout(100)
  }
  await idle(page)
  const combo = (await page.evaluate('window.C4.crit()')) as { bonus: number[] }
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 4))`)
  await idle(page)
  const afterFirst = (await page.evaluate('window.C4.state()')) as { phase: string }
  const currentAfterFirst = (await page.evaluate('window.__CONNECT4__.ui.current')) as number
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 5))`)
  await idle(page)
  const currentAfterSecond = (await page.evaluate('window.__CONNECT4__.ui.current')) as number
  check(
    '#13 deepseek 技能②：消耗 3 棵植物（bugv10 #3）后当前回合可以连下两颗子（bugv10 #4）',
    combo.bonus[0] === 1 && afterFirst.phase === 'playing' && currentAfterFirst === 0 && currentAfterSecond === 1,
    { bonus: combo.bonus[0], currentAfterFirst, currentAfterSecond },
  )

  // 表情差分：连珠 atk → 防守漏挡 win / lose → 结束 win / lose
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,6], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await page.waitForTimeout(200)
  const attackExpr = (await page.evaluate('window.C4.expr()')) as string[]
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(5, 5))`)
  await page.waitForTimeout(120)
  const resolvedExpr = (await page.evaluate('window.C4.expr()')) as string[]
  await idle(page)
  // 攻击结算之后紧接着的 turnStarted 不能把 win / lose 顶掉（bugv9 #13）
  const afterTurn = (await page.evaluate('window.C4.expr()')) as string[]
  check(
    '#13 攻击阶段表情：成线的一方切 atk；防守方没挡住 → 攻击方 win、防守方 lose（回合切换不会顶掉）',
    attackExpr[0] === 'atk' && resolvedExpr[0] === 'win' && resolvedExpr[1] === 'lose' && afterTurn[0] === 'win',
    { attackExpr, resolvedExpr, afterTurn },
  )
  const domExpr = (await page.evaluate('window.C4.hudDom()')) as { expression: string[] }
  check('#13 立绘确实换成了对应差分（DOM 上的 data-expression）', domExpr.expression[0] === 'win', domExpr.expression)

  // 双方都成线、防守方吃了差值伤害 → 受击那一方切 hit
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1],[3,5,2],[3,6,2],[3,7,2]]',
    "{ hp: [6,6], current: 0, magic: [{ cell: 10, kind: 'flower', owner: 0 }] }",
  )
  await page.evaluate(`window.C4.pick(window.C4.cell(1, 4))`)
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(3, 4))`)
  await page.waitForTimeout(280)
  const hitExpr = (await page.evaluate('window.C4.expr()')) as string[]
  const hitSnapshot = (await page.evaluate('window.C4.snap()')) as { finalAttack: number; defenderAttack: number; damaged: number } | null
  await idle(page)
  check(
    '#13 双方都成线时，受到差值伤害的那一方切 hit 差分',
    hitSnapshot?.finalAttack === 5 && hitSnapshot?.defenderAttack === 4 && hitSnapshot?.damaged === 1 && hitExpr[1] === 'hit',
    { hitExpr, snapshot: hitSnapshot },
  )
  await idle(page)

  // 结束：win / lose，并且等约 1 秒才弹结算
  await scenario(page, '[[8,0,1],[8,1,1],[8,2,1],[6,4,2]]', '{ hp: [6,1], current: 0 }')
  await page.evaluate(`window.C4.pick(window.C4.cell(8, 3))`)
  await idle(page)
  await page.evaluate(`window.C4.pick(window.C4.cell(5, 5))`)
  await idle(page, 30000)
  const before = (await page.evaluate('window.C4.state()')) as { showResult: boolean; result: unknown }
  const finalExpr = (await page.evaluate('window.C4.expr()')) as string[]
  await page.waitForTimeout(1150)
  const settled = (await page.evaluate('({ show: window.C4.state().showResult, expr: window.C4.expr() })')) as {
    show: boolean
    expr: string[]
  }
  check(
    '#13 分出胜负后切 win / lose 差分，等约 1 秒才显示结算弹窗',
    before.result !== null &&
      before.showResult === false &&
      finalExpr[0] === 'win' &&
      finalExpr[1] === 'lose' &&
      settled.show === true,
    { before, finalExpr, settled },
  )
  await page.screenshot({ path: `${OUT}/13-result.png` })
}

// ===========================================================================
// 汇总
// ===========================================================================
check('控制台无报错', problems.length === 0, problems.slice(0, 6))
await browser.close()

const failed = results.filter((item) => !item.ok)
console.log(`\n合计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  for (const item of failed) console.log(`FAIL  ${item.item}  ${item.detail}`)
  process.exitCode = 1
}
