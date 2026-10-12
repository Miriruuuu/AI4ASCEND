/**
 * bugv10 逐条验证。
 *
 *   pnpm exec vite preview --port 5199 --strictPort
 *   pnpm exec tsx scripts/verify-bugv10.ts
 *
 * #1 对局结束后魔力植物与魔法阵消失 · #2 技能挑选时只有我方植物 / 棋子高亮，其余变暗（悬停有标识，
 * 勾选后有高光）· #3 平衡性与改名 · #4 杀鲸霸拳同回合连下两颗（第一颗成线也不进攻击阶段）·
 * #5 使用技能后植物与魔法阵消失 · #6 立绘放大 / 血条在立绘上方等宽 / 不显示 HP 数字 ·
 * #7 点技能不弹窗，改在技能旁冒气泡 · #8 开始菜单横向轮播 + 随机角色 + 右侧技能详情 ·
 * #9 新角色 gtp / glm 的技能（精密计算 / 恶龙吐息 / 小一哥 / 毒鸡蛋）·
 * #10 结算菜单的「返回主菜单」· #12 魔力植物四色相间 + 弯曲主干 + 蕨叶长在枝条上
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5199/'
const OUT = '.shots/bugv10'
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
    if (opts.skillReady) {
      opts.skillReady.forEach(function (entry) { game.engine.value.skillReadyAt[entry[0]][entry[1]] = 0; });
    }
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
      current: engine.current, highlightOwner: engine.highlightOwner, highlights: engine.highlights.size,
      bonusActions: [...engine.bonusActions], flames: engine.flames.size, overlay: engine.overlay.size,
      immune: [engine.isImmune(0), engine.isImmune(1)], power: [...engine.powerBonus],
      sabotage: [...engine.sabotage], turnNo: engine.turnNo,
      skillSelect: game.ui.skillSelect ? { player: game.ui.skillSelect.player, slot: game.ui.skillSelect.slot,
        picked: game.ui.skillSelect.picked.length, need: game.ui.skillSelect.need, stage: game.ui.skillSelect.stage,
        target: game.ui.skillSelect.target } : null,
      skillBubble: game.ui.skillBubble ? { ...game.ui.skillBubble } : null,
      hint: game.ui.hint, mode: game.ui.mode, notice: game.ui.notice ? game.ui.notice.title : null };
  },
  hp: () => window.__CONNECT4__.engine.value.hp.slice(),
  board: () => window.__CONNECT4__.engine.value.board.slice(),
  snap: () => JSON.parse(JSON.stringify(window.__CONNECT4__.engine.value.attack)),
  characters: () => [...window.__CONNECT4__.characters],
  randomFlags: () => [...window.__CONNECT4__.ui.characterRandom],
  // --- #1 / #5 魔力植物 ---
  plants: () => Array.from(window.__CONNECT4__.engine.value.magic.values()).map(function (p) { return { cell: p.cell, kind: p.kind, owner: p.owner }; }),
  magicMeshes: () => {
    const view = window.__CONNECT4__.scene.value.magic;
    let meshes = 0;
    view.group.traverse(function (o) { if (o.isMesh) meshes += 1; });
    return { count: view.count, meshes: meshes, children: view.group.children.length };
  },
  // --- #2 技能挑选的高亮 / 变暗 ---
  skillVisual: (player, ownCells, otherCells) => {
    const game = window.__CONNECT4__;
    const scene = game.scene.value;
    const pieces = scene.pieces;
    const read = function (cell) {
      const record = pieces.__records ? pieces.__records.get(cell) : null;
      return record || null;
    };
    const pieceState = function (cell) {
      const mesh = pieces.get(cell);
      if (!mesh) return null;
      const material = mesh.material;
      const marker = mesh.getObjectByName('select-marker');
      return { opacity: Number(material.opacity.toFixed(3)), transparent: material.transparent,
        emissive: Number(material.emissiveIntensity.toFixed(3)),
        marker: !!marker, markerVisible: marker ? marker.visible : false };
    };
    const plantState = function (cell) {
      const record = scene.magic.at(cell);
      if (!record) return null;
      const colors = [];
      record.plant.traverse(function (o) { if (o.isMesh && o.material && o.material.color) colors.push('#' + o.material.color.getHexString()); });
      return { dimmed: record.dimmed, picked: record.picked, selecting: record.selecting,
        pickRing: record.pickRing.visible, aura: record.aura.visible, colors: colors };
    };
    void read;
    return {
      own: ownCells.map(pieceState), other: otherCells.map(pieceState),
      ownPlants: ownCells.map(plantState), otherPlants: otherCells.map(plantState),
    };
  },
  // --- #4 / #9 技能操作 ---
  skillReady: (player, slot) => { window.__CONNECT4__.engine.value.skillReadyAt[player][slot] = 0; window.__CONNECT4__.syncUi(); return true; },
  toggleSkill: (player, slot) => window.__CONNECT4__.toggleSkill(player, slot),
  cancelSkill: () => window.__CONNECT4__.cancelSkillSelect(),
  skills: () => JSON.parse(JSON.stringify(window.__CONNECT4__.ui.skills)),
  skillSpecs: (player, id) => {
    const game = window.__CONNECT4__;
    game.setCharacter(player, id);
    game.engine.value.loadScenario(new Array(81).fill(0), { hp: [6, 6], current: player, firstPlayer: player, magic: [] });
    game.syncUi();
    const list = JSON.parse(JSON.stringify(game.ui.skills[player]));
    return list.map(function (s) { return { name: s.name, cost: s.cost, cooldown: s.remaining, effect: s.effect,
      endsTurn: s.endsTurn, targetsCell: s.targetsCell, desc: s.desc }; });
  },
  addPlant: (cell, owner) => {
    const engine = window.__CONNECT4__.engine.value;
    engine.board[cell] = owner + 1;
    engine.magic.set(cell, { cell: cell, kind: 'flower', owner: owner });
    window.__CONNECT4__.scene.value.syncMagic(Array.from(engine.magic.values()));
    window.__CONNECT4__.syncUi();
    return true;
  },
  withPlants: (cells, owner) => {
    const engine = window.__CONNECT4__.engine.value;
    cells.forEach(function (cell) {
      engine.board[cell] = owner + 1;
      engine.magic.set(cell, { cell: cell, kind: 'flower', owner: owner });
    });
    window.__CONNECT4__.scene.value.syncMagic(Array.from(engine.magic.values()));
    window.__CONNECT4__.syncUi();
    return true;
  },
  /** 直接摆一批棋子（不动回合 / 血量），用于"技能释放之后再制造一个攻击局面"。 */
  setBoard: (stones, current) => {
    const game = window.__CONNECT4__;
    const engine = game.engine.value;
    engine.board = new Array(81).fill(0);
    stones.forEach(function (entry) { engine.board[entry[0] * 9 + entry[1]] = entry[2]; });
    if (current !== undefined && current !== null) engine.current = current;
    game.scene.value.syncBoard(engine.board);
    game.syncUi();
    return { current: engine.current, phase: engine.phase };
  },
  flames: () => Array.from(window.__CONNECT4__.engine.value.flames.entries()).sort(function (a, b) { return a[0] - b[0]; }),
  flameScene: () => window.__CONNECT4__.scene.value.flames.cells.slice().sort(function (a, b) { return a - b; }),
  uiFlames: () => JSON.parse(JSON.stringify(window.__CONNECT4__.ui.flames)),
  // 火球：记录调用与命中瞬间叠了多少"对撞级"特效
  spyFireball: () => {
    const flames = window.__CONNECT4__.scene.value.flames;
    const effects = window.__CONNECT4__.scene.value.effects;
    if (!flames.__spy) {
      flames.__spy = { calls: [], burstsAtImpact: 0, headTrace: [] };
      const original = flames.fireball.bind(flames);
      flames.fireball = function (from, to, options) {
        const base = effects.__sunburstCount || 0;
        const entry = { from: [from.x, from.y, from.z], to: [to.x, to.y, to.z], impact: null };
        flames.__spy.calls.push(entry);
        const inner = options && options.onImpact;
        const wrapped = Object.assign({}, options, {
          onImpact: function () {
            // 先让宿主自己叠特效，再统计"这一瞬间叠了多少"（bugv10 #9）
            if (inner) inner();
            entry.impact = { sunburst: (effects.__sunburstCount || 0) - base, blast: effects.__blastCount || 0 };
            flames.__spy.burstsAtImpact += 1;
          },
        });
        return original(from, to, wrapped);
      };
      const sunburst = effects.sunburst.bind(effects);
      effects.__sunburstCount = 0;
      effects.sunburst = function () { effects.__sunburstCount += 1; return sunburst.apply(null, arguments); };
    }
    return true;
  },
  fireballSpy: () => JSON.parse(JSON.stringify(window.__CONNECT4__.scene.value.flames.__spy || { calls: [] })),
  spyShatter: () => {
    const pieces = window.__CONNECT4__.scene.value.pieces;
    if (!pieces.__shatterSpy) {
      pieces.__shatterSpy = [];
      const original = pieces.shatter.bind(pieces);
      pieces.shatter = function (mesh, owner, origin, other) {
        pieces.__shatterSpy.push({ owner: owner, at: origin ? [origin.x, origin.y, origin.z] : null });
        return original(mesh, owner, origin, other);
      };
    }
    return true;
  },
  shatterSpy: () => JSON.parse(JSON.stringify(window.__CONNECT4__.scene.value.pieces.__shatterSpy || [])),
  clearSpies: () => {
    const scene = window.__CONNECT4__.scene.value;
    if (scene.pieces.__shatterSpy) scene.pieces.__shatterSpy = [];
    if (scene.flames.__spy) scene.flames.__spy = { calls: [], burstsAtImpact: 0, headTrace: [] };
    return true;
  },
  stageCount: (owner) => window.__CONNECT4__.scene.value.stageCount(owner),
  /** 某一格棋盘交点在屏幕上的像素坐标（真实鼠标悬停用）。 */
  screenOf: (cell) => {
    const scene = window.__CONNECT4__.scene.value;
    const Vector3 = window.__THREE_VECTOR3__;
    const world = scene.pieces.worldOf(cell, new Vector3());
    world.project(scene.rig.camera);
    const rect = document.getElementById('board-canvas').getBoundingClientRect();
    return {
      x: rect.left + ((world.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - world.y) / 2) * rect.height,
      ndc: [Number(world.x.toFixed(3)), Number(world.y.toFixed(3))],
    };
  },
  setHover: (cell) => { window.__CONNECT4__.scene.value.setSelectHover(cell); return true; },
  // --- #6 HUD 布局 ---
  hudLayout: () => {
    const panels = Array.from(document.querySelectorAll('.hud .player-panel'));
    const read = function (panel) {
      const art = panel.querySelector('.portrait__art') || panel.querySelector('.portrait');
      const hp = panel.querySelector('.hp-bar');
      const value = panel.querySelector('.hp-value');
      const label = panel.querySelector('.hp-label');
      const shield = panel.querySelector('.shield-value');
      const rect = art ? art.getBoundingClientRect() : null;
      const hpRect = hp ? hp.getBoundingClientRect() : null;
      const valueRect = value ? value.getBoundingClientRect() : null;
      const style = value ? getComputedStyle(value) : null;
      // 视觉隐藏的判定：clip-path / 尺寸塌缩 / visibility / display / opacity
      const clipped = !!style && !!style.clipPath && style.clipPath !== 'none';
      const tiny = !valueRect || valueRect.width * valueRect.height < 24;
      const hidden = !value || tiny || clipped ||
        (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05));
      return { art: rect ? { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.left), y: Math.round(rect.top) } : null,
        hp: hpRect ? { w: Math.round(hpRect.width), x: Math.round(hpRect.left), bottom: Math.round(hpRect.bottom), top: Math.round(hpRect.top) } : null,
        portraitTop: rect ? Math.round(rect.top) : null,
        hpValueHidden: hidden, hasHpLabel: !!label, hasShieldLabel: !!shield,
        text: (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
    };
    return panels.map(read);
  },
  // --- #7 技能气泡 ---
  bubbleDom: (side, slot) => {
    const bar = document.querySelector('[data-skill-bar="' + side + '"]');
    if (!bar) return null;
    const button = bar.querySelectorAll('.skill-slot')[slot];
    if (!button) return null;
    const bubble = button.querySelector('.skill-bubble') || bar.querySelector('.skill-bubble');
    const buttonRect = button.getBoundingClientRect();
    const rect = bubble ? bubble.getBoundingClientRect() : null;
    return { exists: !!bubble, text: bubble ? (bubble.textContent || '').replace(/\\s+/g, ' ').trim() : null,
      buttonRect: { x: Math.round(buttonRect.left), y: Math.round(buttonRect.top), w: Math.round(buttonRect.width), h: Math.round(buttonRect.height) },
      rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      modals: document.querySelectorAll('.overlay .modal').length };
  },
  clickSlot: (side, slot) => {
    const bar = document.querySelector('[data-skill-bar="' + side + '"]');
    if (!bar) return false;
    const button = bar.querySelectorAll('.skill-slot')[slot];
    if (!button) return false;
    button.click();
    return true;
  },
  // --- #8 开始菜单轮播 ---
  menu: () => {
    const menu = document.querySelector('.start-menu');
    if (!menu) return null;
    const readCards = function (root) {
      return Array.from(root.querySelectorAll('.character-card')).map(function (card) {
        const img = card.querySelector('img');
        const rect = card.getBoundingClientRect();
        return { id: card.getAttribute('data-character') || null, random: card.classList.contains('is-random'),
          active: card.classList.contains('is-active'), name: (card.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
          art: img ? img.getAttribute('src') : null, w: Math.round(rect.width), h: Math.round(rect.height) };
      });
    };
    const arrows = Array.from(menu.querySelectorAll('[data-carousel]')).map(function (el) { return el.getAttribute('data-carousel'); });
    const detail = menu.querySelector('.character-detail');
    const carousel = menu.querySelector('.character-carousel') || menu.querySelector('.character-picker');
    const menuRect = menu.getBoundingClientRect();
    const carouselRect = carousel ? carousel.getBoundingClientRect() : null;
    const detailRect = detail ? detail.getBoundingClientRect() : null;
    return { cards: readCards(menu), arrows: arrows, hasDetail: !!detail,
      detailText: detail ? (detail.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220) : null,
      sideBySide: !!(carouselRect && detailRect && detailRect.left > carouselRect.right - 24),
      overflowY: menuRect.height - window.innerHeight };
  },
  clickCard: (id) => {
    const card = document.querySelector('.character-card[data-character="' + id + '"]');
    if (!card) return false;
    card.click();
    return true;
  },
  clickArrow: (dir) => {
    const el = document.querySelector('[data-carousel="' + dir + '"]');
    if (!el) return false;
    el.click();
    return true;
  },
  // --- #10 结算 ---
  resultButtons: () => Array.from(document.querySelectorAll('.modal__actions button')).map(function (b) { return (b.textContent || '').trim(); }),
  clickResultButton: (text) => {
    const list = Array.from(document.querySelectorAll('.modal__actions button'));
    const hit = list.find(function (b) { return (b.textContent || '').indexOf(text) >= 0; });
    if (!hit) return false;
    hit.click();
    return true;
  },
  // --- #12 魔力植物结构（bugv10 追加 #3 引入"千层饼"，bugv11 #4 又退回按部位分色） ---
  plantStructure: (cell) => {
    const record = window.__CONNECT4__.scene.value.magic.at(cell);
    if (!record) return null;
    const hex = function (material) { return '#' + material.color.getHexString(); };
    const layers = ['base', 'inner', 'outer', 'green'].map(function (key) {
      const material = record.materials[key];
      return { key: key, color: hex(material), opacity: Number(material.opacity.toFixed(2)) };
    });
    const layerMeshes = record.plant.children.filter(function (child) { return child.isMesh; });
    return {
      kind: record.kind,
      scale: Number(record.root.scale.x.toFixed(2)),
      layers: layers,
      layerColors: layers.map(function (item) { return item.color; }),
      // 每个 mesh 用的都是这四种颜色之一（bugv11 #4：按部位分色，不再叠层混色）
      meshColors: layerMeshes.map(function (mesh) { return hex(mesh.material); }),
      meshes: layerMeshes.length,
      triangles: layerMeshes.reduce(function (sum, mesh) {
        const index = mesh.geometry.getIndex();
        return sum + (index ? index.count / 3 : 0);
      }, 0),
      parts: record.parts,
      sway: Number(record.root.rotation.z.toFixed(4)),
      auraVisible: record.aura.visible,
      circleVisible: record.ring.visible,
      circleColor: hex(record.ring.material),
    };
  },
  plantParts: (cell) => {
    const record = window.__CONNECT4__.scene.value.magic.at(cell);
    if (!record) return null;
    return { leaves: record.parts.leaves, stems: record.parts.stems,
      maxLeafGap: Number(record.parts.maxLeafGap.toFixed(4)), bend: Number(record.parts.bend.toFixed(4)) };
  },
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

/** 轮播是分页渲染的：翻页直到目标卡片出现在 DOM 里（最多翻 4 次）。 */
async function ensureCard(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const found = (await page.evaluate(`!!document.querySelector('.character-card[data-character="${id}"]')`)) as boolean
    if (found) return
    await page.evaluate(`window.C4.clickArrow('prev')`)
    await page.waitForTimeout(300)
  }
}

const page = await openPage('A')
await page.evaluate('window.C4.spyFireball()')
await page.evaluate('window.C4.spyShatter()')

// ===========================================================================
// #1 对局结束后魔力植物与魔法阵消失
// ===========================================================================
{
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1]]',
    "{ hp: [6,1], current: 0, magic: [{ cell: 40, kind: 'flower', owner: 0 }, { cell: 41, kind: 'fern', owner: 1 }] }",
  )
  const before = (await page.evaluate('window.C4.magicMeshes()')) as { count: number; meshes: number }
  await page.evaluate(`window.C4.pickStart(window.C4.cell(1, 4))`)
  await idle(page)
  // 防守方随便落一子（不成线）→ 1 点血被打掉 → 对局结束
  await page.evaluate(`window.C4.pickStart(window.C4.cell(4, 4))`)
  await idle(page)
  await page.waitForTimeout(1600)
  const after = (await page.evaluate('window.C4.magicMeshes()')) as { count: number; meshes: number; children: number }
  const state = (await page.evaluate('window.C4.state()')) as { phase: string }
  check(
    '#1 对局结束后棋盘上的魔力植物与其魔法阵一起消失',
    before.count === 2 && before.meshes > 10 && state.phase === 'gameOver' && after.count === 0 && after.meshes === 0,
    { before, after, phase: state.phase },
  )
  await page.screenshot({ path: `${OUT}/01-gameover-plants.png` })
}

// ===========================================================================
// #2 技能挑选：只有我方植物 / 站在上面的棋子高亮，其余变暗；悬停有标识；勾选后有高光
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,1],[2,2,1],[6,6,2]]',
    "{ hp: [6,6], current: 0, characters: ['deepseek','gemini'], skillReady: [[0,0]], " +
      "magic: [{ cell: 40, kind: 'flower', owner: 0 }, { cell: 20, kind: 'grass', owner: 0 }, { cell: 60, kind: 'fern', owner: 1 }] }",
  )
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(320)
  const visual = (await page.evaluate('window.C4.skillVisual(0, [40, 20], [60])')) as {
    own: Array<{ opacity: number; marker: boolean; emissive: number } | null>
    other: Array<{ opacity: number; marker: boolean; emissive: number } | null>
    ownPlants: Array<{ dimmed: boolean; selecting: boolean } | null>
    otherPlants: Array<{ dimmed: boolean; colors: string[]; aura: boolean } | null>
  }
  const selecting = (await page.evaluate('window.C4.state()')) as { skillSelect: { stage: string; need: number } | null }
  const ownLit = visual.own.every((item) => item !== null && item.opacity > 0.9 && item.marker)
  const otherDim = visual.other.every((item) => item !== null && item.opacity < 0.5)
  const plantDim = visual.otherPlants.every((item) => item !== null && item.dimmed && !item.aura)
  check(
    '#2 挑选魔力植物时：只有我方植物上的棋子保持明亮并带高亮标记，其它棋子 / 植物一起变暗',
    selecting.skillSelect?.stage === 'plants' &&
      selecting.skillSelect?.need === 1 &&
      ownLit &&
      otherDim &&
      plantDim &&
      visual.ownPlants.every((item) => item !== null && item.selecting && !item.dimmed),
    { ownLit, otherDim, plantDim, own: visual.own, other: visual.other, plants: visual.otherPlants },
  )

  // 真·鼠标悬停到"我方植物上的棋子"→ 这一颗的高亮标识变强
  const screen = (await page.evaluate('window.C4.screenOf(40)')) as { x: number; y: number; ndc: number[] }
  await page.mouse.move(screen.x, screen.y)
  await page.waitForTimeout(260)
  const hovered = (await page.evaluate('window.C4.skillVisual(0, [40], [])')) as {
    own: Array<{ markerVisible: boolean; emissive: number } | null>
  }
  // 机制直连（避免视差导致鼠标没落在这一格上）
  await page.evaluate('window.C4.setHover(40)')
  await page.waitForTimeout(120)
  const hoveredDirect = (await page.evaluate('window.C4.skillVisual(0, [40], [])')) as {
    own: Array<{ markerVisible: boolean; emissive: number } | null>
  }
  check(
    '#2 鼠标悬停到我方在魔力植物上的棋子时，这一颗有更强的高亮标识',
    hoveredDirect.own[0] !== null &&
      hoveredDirect.own[0]!.markerVisible &&
      hoveredDirect.own[0]!.emissive > 0.6 &&
      (hovered.own[0]?.emissive ?? 0) >= 0.42,
    { screen, hovered: hovered.own, hoveredDirect: hoveredDirect.own },
  )

  // 多选技能：勾选一棵之后要留下高光标识
  await scenario(
    page,
    '[[4,4,1],[2,2,1],[6,6,2]]',
    "{ hp: [6,6], current: 0, characters: ['gtp','gemini'], skillReady: [[0,1]], " +
      "magic: [{ cell: 40, kind: 'flower', owner: 0 }, { cell: 20, kind: 'grass', owner: 0 }, { cell: 22, kind: 'grass', owner: 0 }] }",
  )
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(200)
  await page.evaluate('window.C4.pick(window.C4.cell(4, 4))')
  await page.waitForTimeout(260)
  const multi = (await page.evaluate('window.C4.skillVisual(0, [40, 20], [])')) as {
    ownPlants: Array<{ picked: boolean; pickRing: boolean } | null>
  }
  const picked = (await page.evaluate('window.C4.state()')) as { skillSelect: { picked: number; stage: string } | null }
  check(
    '#2 多选技能：勾选过的魔力植物有独立高光标识（其余仍可继续选）',
    picked.skillSelect?.picked === 1 &&
      picked.skillSelect?.stage === 'plants' &&
      multi.ownPlants[0]?.picked === true &&
      multi.ownPlants[0]?.pickRing === true &&
      multi.ownPlants[1]?.picked === false,
    { picked: picked.skillSelect, plants: multi.ownPlants },
  )
  await page.evaluate('window.C4.cancelSkill()')
  await page.screenshot({ path: `${OUT}/02-skill-select.png` })
}

// ===========================================================================
// #3 平衡性与改名
// ===========================================================================
{
  const deepseek = (await page.evaluate(`window.C4.skillSpecs(0, 'deepseek')`)) as Array<Record<string, unknown>>
  const gemini = (await page.evaluate(`window.C4.skillSpecs(0, 'gemini')`)) as Array<Record<string, unknown>>
  const gtp = (await page.evaluate(`window.C4.skillSpecs(0, 'gtp')`)) as Array<Record<string, unknown>>
  const glm = (await page.evaluate(`window.C4.skillSpecs(0, 'glm')`)) as Array<Record<string, unknown>>
  check(
    '#3 deepseek 改名（大胃袋 / 杀鲸霸拳）+ 2 技能消耗 3、冷却 10',
    deepseek[0]?.name === '大胃袋' &&
      deepseek[1]?.name === '杀鲸霸拳' &&
      deepseek[1]?.cost === 3 &&
      deepseek[1]?.cooldown === 10,
    deepseek,
  )
  check(
    '#3 gemini 改名（猫的憩息 / 双子星）+ 2 技能消耗 2、冷却 10',
    gemini[0]?.name === '猫的憩息' &&
      gemini[1]?.name === '双子星' &&
      gemini[1]?.cost === 2 &&
      gemini[1]?.cooldown === 10,
    gemini,
  )
  check(
    '#3 新增角色 gtp（精密计算 / 恶龙吐息）与 glm（小一哥 / 毒鸡蛋）',
    gtp[0]?.name === '精密计算' &&
      gtp[0]?.cost === 1 &&
      gtp[0]?.cooldown === 10 &&
      gtp[1]?.name === '恶龙吐息' &&
      gtp[1]?.cost === 3 &&
      gtp[1]?.cooldown === 12 &&
      gtp[1]?.targetsCell === true &&
      glm[0]?.name === '小一哥' &&
      glm[1]?.name === '毒鸡蛋' &&
      glm[1]?.cost === 3,
    { gtp, glm },
  )
}

// ===========================================================================
// #4 杀鲸霸拳：当前回合连下两颗，第一颗成线也不进入攻击阶段
// ===========================================================================
{
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1],[8,8,2]]',
    "{ hp: [6,6], current: 0, characters: ['deepseek','gemini'], skillReady: [[0,1]], magic: [] }",
  )
  await page.evaluate('window.C4.withPlants([0, 2, 4], 0)')
  await page.waitForTimeout(120)
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(150)
  for (const cell of [0, 2, 4]) {
    await page.evaluate(`window.C4.pick(window.C4.cell(0, ${cell}))`)
    await page.waitForTimeout(120)
  }
  await idle(page)
  const afterSkill = (await page.evaluate('window.C4.state()')) as {
    bonusActions: number[]
    current: number
    phase: string
  }
  // 第一颗子成线：不能进入攻击阶段
  await page.evaluate(`window.C4.pickStart(window.C4.cell(1, 4))`)
  await idle(page)
  const first = (await page.evaluate('window.C4.state()')) as {
    phase: string
    current: number
    highlights: number
    bonusActions: number[]
    snap: unknown
  }
  const firstSnap = (await page.evaluate('window.C4.snap()')) as unknown
  // 第二颗子下完：按最终局面进入攻击阶段
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 0))`)
  await idle(page)
  const second = (await page.evaluate('window.C4.state()')) as {
    phase: string
    current: number
    highlights: number
  }
  check(
    '#4 杀鲸霸拳：同一回合连下两颗，第一颗成线也不会进入攻击阶段（防守方无法反击）',
    afterSkill.bonusActions[0] === 1 &&
      afterSkill.current === 0 &&
      first.phase === 'playing' &&
      first.current === 0 &&
      first.bonusActions[0] === 0 &&
      first.highlights === 0 &&
      firstSnap === null &&
      second.phase === 'awaitingDefense' &&
      second.highlights >= 4,
    { afterSkill, first, firstSnap, second },
  )
  await page.evaluate(`window.C4.pickStart(window.C4.cell(4, 4))`)
  await idle(page)
  await page.screenshot({ path: `${OUT}/04-double-move.png` })
}

// ===========================================================================
// #5 使用技能后魔力植物与魔法阵消失
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,1],[2,2,1]]',
    "{ hp: [6,6], current: 0, characters: ['deepseek','gemini'], skillReady: [[0,0]], " +
      "magic: [{ cell: 40, kind: 'flower', owner: 0 }, { cell: 20, kind: 'grass', owner: 0 }] }",
  )
  const before = (await page.evaluate('window.C4.magicMeshes()')) as { count: number; meshes: number }
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(180)
  await page.evaluate('window.C4.pick(window.C4.cell(4, 4))')
  await idle(page)
  await page.waitForTimeout(700)
  const after = (await page.evaluate('window.C4.magicMeshes()')) as { count: number; meshes: number }
  const shield = (await page.evaluate('window.C4.state()')) as { shield: number[] }
  check(
    '#5 使用技能后：被消耗的魔力植物与它脚下的魔法阵真的消失了（棋盘上只剩没被消耗的那棵）',
    before.count === 2 && shield.shield[0] === 1 && after.count === 1 && after.meshes > 0,
    { before, after, shield: shield.shield },
  )
  // 第二棵也消耗掉：整株（含魔法阵网格）要清零
  await page.evaluate('window.C4.skillReady(0, 0)')
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(180)
  await page.evaluate('window.C4.pick(window.C4.cell(2, 2))')
  await idle(page)
  await page.waitForTimeout(700)
  const cleared = (await page.evaluate('window.C4.magicMeshes()')) as { count: number; meshes: number }
  check(
    '#5 消耗掉最后一棵之后，植物层完全没有残留（网格数为 0）',
    cleared.count === 0 && cleared.meshes === 0,
    cleared,
  )
}

// ===========================================================================
// #6 立绘放大 / 血条在立绘上方且等宽 / 不显示 HP 数字
// ===========================================================================
{
  await scenario(page, '[[4,4,1],[2,2,2]]', '{ hp: [5,3], current: 0 }')
  await page.waitForTimeout(320)
  const layout = (await page.evaluate('window.C4.hudLayout()')) as Array<{
    art: { w: number; h: number; y: number } | null
    hp: { w: number; x: number; bottom: number } | null
    portraitTop: number | null
    hpValueHidden: boolean
    hasHpLabel: boolean
    hasShieldLabel: boolean
    text: string
  }>
  const first = layout[0]
  const sameWidth = first?.art && first.hp ? Math.abs(first.art.w - first.hp.w) <= 8 : false
  const above = first?.art && first.hp ? first.hp.bottom <= first.art.y + 6 : false
  check(
    '#6 左右上角立绘放大约 3 倍（≥2.4× 原来的 64×72）且血条在立绘上方、与立绘等宽，面板里不再显示 HP 数字',
    layout.length === 2 &&
      layout.every((item) => (item.art?.w ?? 0) >= 150 && (item.art?.h ?? 0) >= 170) &&
      sameWidth &&
      above &&
      layout.every((item) => item.hpValueHidden && !item.hasHpLabel && !item.hasShieldLabel) &&
      layout.every((item) => !/HP/.test(item.text)),
    layout,
  )
  await page.screenshot({ path: `${OUT}/06-hud.png` })
}

// ===========================================================================
// #7 点技能不弹窗，改在技能旁边冒气泡
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,1],[2,2,2]]',
    "{ hp: [6,6], current: 0, characters: ['deepseek','gemini'], magic: [] }",
  )
  // 冷却中（开局）点技能：不能弹窗，要在按钮旁冒气泡说明原因
  await page.evaluate('window.C4.clickSlot(0, 0)')
  await page.waitForTimeout(260)
  const cooling = (await page.evaluate('window.C4.bubbleDom(0, 0)')) as {
    exists: boolean
    text: string | null
    buttonRect: { x: number; y: number; w: number; h: number }
    rect: { x: number; y: number; w: number; h: number } | null
    modals: number
  } | null
  const coolingState = (await page.evaluate('window.C4.state()')) as { notice: string | null; skillBubble: { slot: number } | null }
  const near =
    cooling?.rect && cooling.buttonRect
      ? Math.abs(cooling.rect.x - cooling.buttonRect.x) < 220 && Math.abs(cooling.rect.y - cooling.buttonRect.y) < 260
      : false
  check(
    '#7 点击技能不再弹窗，而是在技能旁边冒出气泡（含名称与不可用原因）',
    cooling?.exists === true &&
      cooling.modals === 0 &&
      coolingState.notice === null &&
      coolingState.skillBubble?.slot === 0 &&
      near &&
      /冷却|魔力植物/.test(cooling.text ?? ''),
    { cooling, state: coolingState, near },
  )
  // 敌方技能（pve 下 1 号位是 AI）同样只冒气泡
  await scenario(page, '[[4,4,1],[2,2,2]]', "{ hp: [6,6], current: 1, mode: 'pve', characters: ['deepseek','gemini'], magic: [] }")
  await page.evaluate('window.C4.clickSlot(1, 1)')
  await page.waitForTimeout(240)
  const enemy = (await page.evaluate('window.C4.state()')) as { notice: string | null; skillBubble: { slot: number; notice: string } | null }
  const enemyBubble = (await page.evaluate('window.C4.bubbleDom(1, 1)')) as { exists: boolean; modals: number } | null
  check(
    '#7 点敌方技能也只是冒气泡（说明只能用自己那一方），没有弹窗',
    enemy.notice === null &&
      enemyBubble?.exists === true &&
      enemyBubble.modals === 0 &&
      /技能/.test(enemy.skillBubble?.notice ?? ''),
    { state: enemy, dom: enemyBubble },
  )
  await page.screenshot({ path: `${OUT}/07-skill-bubble.png` })
}

// ===========================================================================
// #8 开始菜单：横向轮播 + 随机 + 右侧技能详情
// ===========================================================================
{
  await page.evaluate('window.__CONNECT4__.backToMenu()')
  await page.waitForTimeout(420)
  const first = (await page.evaluate('window.C4.menu()')) as {
    cards: Array<{ id: string | null; random: boolean; name: string; art: string | null }>
    arrows: string[]
    hasDetail: boolean
    detailText: string | null
    sideBySide: boolean
    overflowY: number
  } | null
  const arrowsOk = first?.arrows.includes('prev') === true && first?.arrows.includes('next') === true
  check(
    '#8 开始菜单改成横向轮播：一行 2 个角色 + 左右箭头翻页 + 第一个位置是「随机」',
    first !== null &&
      first.cards.length >= 2 &&
      first.cards.length <= 3 &&
      first.cards[0]?.random === true &&
      first.cards.slice(1).every((card) => !!card.id && !!card.art) &&
      arrowsOk,
    first,
  )
  const page1 = first?.cards.map((card) => card.id ?? 'random').join(',') ?? ''
  await page.evaluate(`window.C4.clickArrow('next')`)
  await page.waitForTimeout(320)
  const second = (await page.evaluate('window.C4.menu()')) as { cards: Array<{ id: string | null }> } | null
  const page2 = second?.cards.map((card) => card.id ?? 'random').join(',') ?? ''
  check(
    '#8 点右箭头会翻到下一页（角色卡换成另外两个）',
    page1 !== '' && page2 !== '' && page1 !== page2,
    { page1, page2 },
  )
  // 点一个角色 → 右侧详情显示它的技能
  await page.evaluate(`window.C4.clickCard('gtp')`)
  await page.waitForTimeout(280)
  const picked = (await page.evaluate('window.C4.menu()')) as {
    hasDetail: boolean
    detailText: string | null
    sideBySide: boolean
    cards: Array<{ id: string | null; active: boolean }>
  } | null
  check(
    '#8 点角色后右侧显示它的技能详情，且菜单是左右两栏布局（高度不再溢出）',
    picked?.hasDetail === true &&
      /精密计算/.test(picked.detailText ?? '') &&
      /恶龙吐息/.test(picked.detailText ?? '') &&
      picked.sideBySide === true &&
      (first?.overflowY ?? 999) <= 0,
    { detail: picked?.detailText?.slice(0, 120), sideBySide: picked?.sideBySide, overflowY: first?.overflowY },
  )
  // 随机选项：选中随机 → 开始游戏时真的会随机抽角色
  await ensureCard(page, 'random')
  await page.evaluate(`window.C4.clickCard('random')`)
  await page.waitForTimeout(200)
  const randomOn = (await page.evaluate('window.C4.randomFlags()')) as boolean[]
  const rolls = new Set<string>()
  for (let i = 0; i < 6; i++) {
    await ensureCard(page, 'random')
    await page.evaluate(`window.C4.clickCard('random')`)
    await page.evaluate('window.__CONNECT4__.startMatch()')
    await page.waitForTimeout(200)
    const chars = (await page.evaluate('window.C4.characters()')) as string[]
    const randomState = (await page.evaluate('window.C4.randomFlags()')) as boolean[]
    rolls.add(`${chars[0]}:${randomState[0]}`)
    await page.evaluate('window.__CONNECT4__.backToMenu()')
    await page.waitForTimeout(200)
  }
  check(
    '#8 选「随机」后进入游戏会随机抽角色（多次开局出现不同角色）',
    randomOn[0] === true && rolls.size >= 2 && [...rolls].every((entry) => entry.endsWith(':true')),
    { randomOn, rolls: [...rolls] },
  )
  await ensureCard(page, 'deepseek')
  await page.evaluate(`window.C4.clickCard('deepseek')`)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/08-start-menu.png` })
}

// ===========================================================================
// #9 gtp 精密计算：直到对手下个回合结束前无敌
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,1],[2,2,2]]',
    "{ hp: [6,6], current: 0, characters: ['gtp','gemini'], skillReady: [[0,0]], magic: [] }",
  )
  await page.evaluate('window.C4.addPlant(window.C4.cell(0, 0), 0)')
  await page.evaluate('window.C4.toggleSkill(0, 0)')
  await page.waitForTimeout(150)
  await page.evaluate('window.C4.pick(window.C4.cell(0, 0))')
  await idle(page)
  const cast = (await page.evaluate('window.C4.state()')) as {
    immune: boolean[]
    current: number
    magicCount: number
  }
  // 对手连珠攻击：伤害被完全挡下（直接在同一个引擎上摆局面，避免重置无敌）
  await page.evaluate(`window.C4.setBoard([[2,1,2],[2,2,2],[2,3,2]], 1)`)
  await page.evaluate(`window.C4.pickStart(window.C4.cell(2, 4))`)
  await idle(page)
  const defending = (await page.evaluate('window.C4.state()')) as { immune: boolean[]; phase: string }
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 8))`)
  await idle(page)
  const hpAfter = (await page.evaluate('window.C4.hp()')) as number[]
  const snap = (await page.evaluate('window.C4.snap()')) as { mode: string; diff: number } | null
  const expired = (await page.evaluate('window.C4.state()')) as { immune: boolean[] }
  check(
    '#9 gtp 精密计算：无敌挡下对手这一击（血不掉），对手回合结束后到期',
    cast.immune[0] === true &&
      cast.current === 1 &&
      cast.magicCount === 0 &&
      defending.immune[0] === true &&
      defending.phase === 'awaitingDefense' &&
      hpAfter[0] === 6 &&
      snap?.mode === 'immune' &&
      expired.immune[0] === false,
    { cast, defending, hpAfter, snap, expired },
  )
  await page.screenshot({ path: `${OUT}/09-immune.png` })
}

// ===========================================================================
// #9 gtp 恶龙吐息：火球 + 横竖烈焰 + 烈焰上落子碎裂
// ===========================================================================
{
  await scenario(
    page,
    '[[4,4,1],[2,2,2]]',
    "{ hp: [6,6], current: 0, characters: ['gtp','gemini'], skillReady: [[0,1]], magic: [] }",
  )
  await page.evaluate('window.C4.clearSpies()')
  await page.evaluate('window.C4.withPlants([0, 2, 4], 0)')
  await page.evaluate('window.C4.toggleSkill(0, 1)')
  await page.waitForTimeout(150)
  for (const cell of [0, 2, 4]) {
    await page.evaluate(`window.C4.pick(window.C4.cell(0, ${cell}))`)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(150)
  const targetStage = (await page.evaluate('window.C4.state()')) as { skillSelect: { stage: string } | null }
  // 选目标位置（4,4）
  await page.evaluate('window.C4.pick(window.C4.cell(4, 4))')
  await idle(page)
  await page.waitForTimeout(300)
  const flames = (await page.evaluate('window.C4.flames()')) as Array<[number, number]>
  const sceneFlames = (await page.evaluate('window.C4.flameScene()')) as number[]
  const uiFlames = (await page.evaluate('window.C4.uiFlames()')) as Array<{ cell: number; remaining: number }>
  const spy = (await page.evaluate('window.C4.fireballSpy()')) as {
    calls: Array<{ from: number[]; to: number[]; impact: { sunburst: number; blast: number } | null }>
    burstsAtImpact: number
  }
  const target = 40
  const rowCol = flames.filter(([cell]) => Math.floor(cell / 9) === 4 || cell % 9 === 4).length
  check(
    '#9 gtp 恶龙吐息：投射火球（命中时叠加对撞级特效），目标位置横竖的空位被烈焰覆盖',
    targetStage.skillSelect?.stage === 'cell' &&
      flames.length >= 14 &&
      rowCol === flames.length &&
      sceneFlames.length === flames.length &&
      uiFlames.length === flames.length &&
      flames.every(([, turns]) => turns >= 4) &&
      spy.calls.length === 1 &&
      spy.burstsAtImpact === 1 &&
      Math.abs(spy.calls[0].to[0] - (target % 9 - 4)) < 0.001 &&
      Math.abs(spy.calls[0].to[2] - (Math.floor(target / 9) - 4)) < 0.001 &&
      (spy.calls[0].impact?.sunburst ?? 0) >= 2,
    { flames: flames.length, rowCol, sceneFlames: sceneFlames.length, uiFlames: uiFlames.length, spy },
  )
  await page.screenshot({ path: `${OUT}/09-fireball.png` })

  // 烈焰上落子 → 碎裂（不进棋盘、换手）
  const before = (await page.evaluate('window.C4.state()')) as { current: number }
  const flameCell = flames.find(([cell]) => cell === cellIndex(4, 0))?.[0] ?? flames[0][0]
  await page.evaluate('window.C4.clearSpies()')
  await page.evaluate(`window.C4.pickStart(${flameCell})`)
  await idle(page)
  await page.waitForTimeout(320)
  const after = (await page.evaluate('window.C4.state()')) as {
    current: number
    hint: string
    board: number[]
  }
  const board = (await page.evaluate('window.C4.board()')) as number[]
  const shatters = (await page.evaluate('window.C4.shatterSpy()')) as Array<{ owner: number; at: number[] | null }>
  const col = flameCell % 9
  const row = Math.floor(flameCell / 9)
  const atCell = shatters.some(
    (entry) => entry.at !== null && Math.abs(entry.at[0] - (col - 4)) < 0.12 && Math.abs(entry.at[2] - (row - 4)) < 0.12,
  )
  check(
    '#9 在烈焰上落子：棋子在形成连珠前就碎裂（棋盘上没有这颗子 + 在该格碎裂），行动作废',
    before.current === 1 &&
      board[flameCell] === 0 &&
      shatters.length >= 1 &&
      atCell &&
      after.current === 0,
    { flameCell, shatters, atCell, cell: board[flameCell], current: after.current, hint: after.hint },
  )
}

// ===========================================================================
// #9 glm 小一哥：本回合伤害 +1，额外一颗攻击棋子从技能槽飞出
// ===========================================================================
{
  await scenario(
    page,
    '[[2,1,2],[2,2,2],[2,3,2]]',
    "{ hp: [6,6], current: 1, characters: ['gemini','glm'], skillReady: [[1,0]], magic: [] }",
  )
  await page.evaluate('window.C4.addPlant(window.C4.cell(0, 8), 1)')
  await page.evaluate('window.C4.toggleSkill(1, 0)')
  await page.waitForTimeout(150)
  await page.evaluate('window.C4.pick(window.C4.cell(0, 8))')
  await idle(page)
  const powered = (await page.evaluate('window.C4.state()')) as { power: number[]; current: number }
  await page.evaluate(`window.C4.pickStart(window.C4.cell(2, 4))`)
  await idle(page)
  const snap = (await page.evaluate('window.C4.snap()')) as { baseDamage: number; finalAttack: number; powerBonus: number }
  const stage = (await page.evaluate('window.C4.stageCount(1)')) as number
  const tally = (await page.evaluate('window.C4.state()')) as { highlights: number }
  check(
    '#9 glm 小一哥：本回合伤害 +1（攻击值 = 基础 + 1），悬浮棋子数跟得上，额外那颗从技能槽飞入',
    powered.power[1] === 1 &&
      powered.current === 1 &&
      snap?.finalAttack === snap.baseDamage + 1 &&
      snap?.powerBonus === 1 &&
      stage === snap.finalAttack &&
      tally.highlights >= 4,
    { powered, snap, stage },
  )
  await page.screenshot({ path: `${OUT}/09-power.png` })
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 8))`)
  await idle(page)
  const hp = (await page.evaluate('window.C4.hp()')) as number[]
  check('#9 小一哥的 +1 真的打进了血条（6 → 1）', hp[0] === 1, { hp })
}

// ===========================================================================
// #9 glm 毒鸡蛋：可以在敌方棋子上落子（必须能连珠、不顶替原棋子）
// ===========================================================================
{
  await scenario(
    page,
    '[[2,1,1],[2,2,2],[2,3,2],[2,4,2],[8,8,1]]',
    "{ hp: [6,6], current: 1, characters: ['gemini','glm'], skillReady: [[1,1]], magic: [] }",
  )
  await page.evaluate('window.C4.addPlant(window.C4.cell(8, 0), 1)')
  await page.evaluate('window.C4.withPlants([72, 74, 76], 1)')
  await page.evaluate('window.C4.toggleSkill(1, 1)')
  await page.waitForTimeout(150)
  for (const cell of [72, 74, 76]) {
    await page.evaluate(`window.C4.pick(${cell})`)
    await page.waitForTimeout(120)
  }
  await idle(page)
  const armed = (await page.evaluate('window.C4.state()')) as { sabotage: boolean[]; current: number }
  // 不能连珠的敌方棋子（8,8）：给提示、不落子
  await page.evaluate(`window.C4.pickStart(window.C4.cell(8, 8))`)
  await page.waitForTimeout(240)
  const refused = (await page.evaluate('window.C4.state()')) as { hint: string; overlay: number }
  const boardRefused = (await page.evaluate('window.C4.board()')) as number[]
  // 能连珠的敌方棋子（2,1）：叠子成线，原棋子留下
  await page.evaluate(`window.C4.pickStart(window.C4.cell(2, 1))`)
  await idle(page)
  const stacked = (await page.evaluate('window.C4.state()')) as { current: number; highlights: number; hint: string }
  const board = (await page.evaluate('window.C4.board()')) as number[]
  check(
    '#9 glm 毒鸡蛋：可以在敌方棋子上落子并形成连珠（原棋子不被顶替），不能连珠的位置会被拒绝并提示',
    armed.sabotage[1] === true &&
      armed.current === 1 &&
      /连珠/.test(refused.hint) &&
      boardRefused[cellIndex(8, 8)] === 1 &&
      refused.overlay === 0 &&
      board[cellIndex(2, 1)] === 1 &&
      stacked.highlights >= 4,
    { armed, refused, stacked, cell88: boardRefused[cellIndex(8, 8)], cell21: board[cellIndex(2, 1)] },
  )
  await page.screenshot({ path: `${OUT}/09-sabotage.png` })
}

// ===========================================================================
// #10 结算菜单：返回主菜单
// ===========================================================================
{
  await scenario(
    page,
    '[[1,1,1],[1,2,1],[1,3,1],[8,8,2]]',
    '{ hp: [6,1], current: 0, characters: ["deepseek","gemini"] }',
  )
  await page.evaluate(`window.C4.pickStart(window.C4.cell(1, 4))`)
  await idle(page)
  await page.evaluate(`window.C4.pickStart(window.C4.cell(4, 4))`)
  await idle(page)
  // 结束动画 + 1 秒延迟之后结算面板自己会弹出来
  const deadline = Date.now() + 8000
  let visible = { showResult: false }
  while (Date.now() < deadline) {
    visible = (await page.evaluate('window.C4.state()')) as { showResult: boolean }
    if (visible.showResult) break
    await page.waitForTimeout(200)
  }
  const buttons = (await page.evaluate('window.C4.resultButtons()')) as string[]
  await page.evaluate(`window.C4.clickResultButton('返回主菜单')`)
  await page.waitForTimeout(420)
  const back = (await page.evaluate('window.C4.state()')) as { screen: string; showResult: boolean }
  const menuDom = (await page.evaluate(`!!document.querySelector('.start-menu')`)) as boolean
  check(
    '#10 结算菜单新增「返回主菜单」按钮，点了真的回到主菜单',
    visible.showResult === true &&
      buttons.some((text) => text.includes('返回主菜单')) &&
      back.screen === 'menu' &&
      back.showResult === false &&
      menuDom === true,
    { buttons, back, menuDom },
  )
}

// ===========================================================================
// #12 魔力植物：按部位分色（bugv11 #4 回退）+ 主干弯曲 + 蕨叶长在枝条上
// ===========================================================================
{
  await scenario(page, '[[4,4,1]]', '{ hp: [6,6], current: 0 }')
  const shapes = (await page.evaluate(`(function () {
    const out = {};
    ['flower', 'grass', 'fern'].forEach(function (kind) {
      window.__CONNECT4__.scene.value.magic.despawn(40);
      window.__CONNECT4__.scene.value.magic.spawn(40, kind, null, false);
      out[kind] = window.C4.plantStructure(40);
    });
    return out;
  })()`)) as Record<
    string,
    {
      layers: Array<{ key: string; color: string; opacity: number }>
      layerColors: string[]
      meshColors: string[]
      meshes: number
      triangles: number
      parts: { leaves: number; stems: number; maxLeafGap: number; bend: number }
      scale: number
    }
  >
  // bugv11 #4：每个部位一块纯色（四种颜色都在调色板里、每块不透明、不再叠层混色）
  const palette = ['#8a5a33', '#f0c247', '#f2f6fd', '#4f9d5d']
  const partColored = Object.values(shapes).every(
    (shape) =>
      shape.meshColors.length > 0 &&
      shape.meshColors.every((color) => palette.includes(color)) &&
      shape.layers.every((layer) => layer.opacity === 1),
  )
  check(
    '#12 魔力植物按部位分色：每块纯色（褐 / 黄 / 银白 / 绿），不再叠层混色',
    partColored && Object.values(shapes).every((shape) => shape.meshes > 0 && shape.meshes <= 4),
    {
      meshColors: Object.fromEntries(Object.entries(shapes).map(([kind, shape]) => [kind, shape.meshColors])),
      meshes: Object.fromEntries(Object.entries(shapes).map(([kind, shape]) => [kind, shape.meshes])),
    },
  )
  const bends = Object.values(shapes).map((shape) => shape.parts.bend)
  check(
    '#12 三种植物的主干都是随机角度弯曲的（零件水平偏移 > 0.02，不再是笔直的竹竿）',
    bends.every((bend) => bend > 0.02) && new Set(bends.map((bend) => bend.toFixed(3))).size >= 2,
    { bends: Object.fromEntries(Object.entries(shapes).map(([kind, shape]) => [kind, Number(shape.parts.bend.toFixed(4))])) },
  )
  const fern = shapes.fern.parts
  check(
    '#12 蕨类的叶子长在枝条上（≥8 片叶，叶片内端到最近枝干的距离 < 0.06）',
    fern.leaves >= 8 && fern.maxLeafGap < 0.06,
    { leaves: fern.leaves, stems: fern.stems, maxLeafGap: Number(fern.maxLeafGap.toFixed(4)) },
  )
  await page.screenshot({ path: `${OUT}/12-plants.png` })
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

/** 便捷：行列 → 棋盘下标（脚本里用来断言棋盘）。 */
function cellIndex(row: number, col: number): number {
  return row * 9 + col
}
