#!/usr/bin/env node
/**
 * bugv29 验收探针。
 *
 *   node scripts/verify-bugv29.mjs
 *
 * 覆盖：
 *   #1 滚动条改成主题化的细滚动条
 *   #2 对局结束后"上一步落子"高亮必须消失
 *   #3 gtp 1 技能：护甲 = 生命上限、不交回合；gtp 2 技能：火球燃火 + 全屏演出（不交回合）
 *   #4 特效演出：护盾镜面反光 / 火球全屏火红 / 播种逐棵长出 / 杀鲸霸拳速度线
 *
 * ⚠️ headless 下 3D 动画的 rAF 会被节流，页面里 `await handleCellPick()` 可能长时间不返回。
 *    所以这里每一步都用 `T.settle()`（循环 skipAnimations 直到 busy 落地）代替，
 *    并且每个 `ev()` 都有硬超时 —— 任何一步卡住都只会记一条 FAIL，不会拖住整轮。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { launch, startStaticServer } from './ui-cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync('dist/index.html')) {
  console.error('缺少 dist/，请先 `npx vite build`')
  process.exit(2)
}

const server = await startStaticServer('dist')
const results = []
const check = (item, ok, detail) => {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ item, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item}  ${text}`)
}

const { cdp, close } = await launch({
  url: server.url + '/index.html',
  readyExpr: 'Boolean(window.__CONNECT4__)',
  timeoutMs: 40000,
})

/** 带硬超时的求值：卡住就返回 `{ __timeout: true }`，不拖住整轮。 */
async function ev(expr, timeoutMs = 15000) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  })
  try {
    return await Promise.race([cdp.eval(`(async () => { ${expr} })()`, { awaitPromise: true }), guard])
  } catch (error) {
    return { __error: String(error && error.message ? error.message : error) }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function waitFor(expr, timeoutMs = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = await ev(`return Boolean(${expr});`, 3000)
    if (hit === true) return true
    await sleep(120)
  }
  return false
}

mkdirSync('.shots/bugv29', { recursive: true })
await cdp.send('Page.enable')
const shot = async (name) => {
  const r = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ])
  if (!r) return
  writeFileSync(`.shots/bugv29/${name}.png`, Buffer.from(r.data, 'base64'))
}

/** 页面内的通用工具：摆局面 / 放技能 / 等动画落地。 */
const SETUP = `
window.T = {
  g: () => window.__CONNECT4__,
  /** 等动画序列落地：循环 skipAnimations 直到 ui.busy 连续几次为 false。 */
  async settle(maxMs = 6000) {
    const g = window.__CONNECT4__;
    const t0 = Date.now();
    let idle = 0;
    while (Date.now() - t0 < maxMs) {
      g.skipAnimations();
      await new Promise((r) => setTimeout(r, 20));
      if (g.ui.busy) idle = 0;
      else idle += 1;
      if (idle >= 4) return true;
    }
    return !g.ui.busy;
  },
  /** 落子 / 点植物：不等动画，交给 settle 收尾。 */
  pick(cell) { window.__CONNECT4__.handleCellPick(cell); },
  /** 等棋盘空闲（跳过动画）再点，避免落在 busy 上被静默丢弃。 */
  async act(cell, maxMs = 6000) {
    const g = window.__CONNECT4__;
    const t0 = Date.now();
    while (g.ui.busy && Date.now() - t0 < maxMs) {
      g.skipAnimations();
      await new Promise((r) => setTimeout(r, 20));
    }
    g.handleCellPick(cell);
  },
  /** 摆一个"0 号位棋子压着植物"的局面，并清掉某个技能的冷却。 */
  prep(slot, cells) {
    const g = window.__CONNECT4__;
    const e = g.engine.value;
    for (const cell of cells) {
      e.board[cell] = 1;
      e.magic.set(cell, { cell, kind: 'flower', owner: 0 });
    }
    e.current = 0;
    e.skillReadyAt[0][slot] = 0;
    g.syncUi();
    return { current: e.current, phase: e.phase };
  },
  /** 找第一个可落子的空位。 */
  firstCell() {
    const e = window.__CONNECT4__.engine.value;
    for (let i = 0; i < 81; i++) if (e.canPlaceAt(i)) return i;
    return -1;
  },
  /** 开一局（可选角色），并保证骰子浮层已经消失。 */
  async start(c0, c1) {
    const g = window.__CONNECT4__;
    g.ui.mode = 'pvp';
    if (c0) g.setCharacter(0, c0);
    if (c1) g.setCharacter(1, c1);
    const p = g.startMatch().catch(() => {});
    await this.settle(3000);
    await Promise.race([p, new Promise((r) => setTimeout(r, 400))]);
    if (g.ui.diceVisible) g.hideDice();
    await this.settle(1500);
    return { screen: g.ui.screen, phase: g.ui.phase };
  },
};
true
`

try {
  await waitFor('document.querySelector(".promise-modal")')
  await ev(`document.querySelector('.promise-modal .primary-btn')?.click(); return true;`)
  await sleep(200)
  await ev(SETUP)

  // --- #1 滚动条 ---------------------------------------------------------
  console.log('[step] #1 滚动条')
  {
    const scroll = await ev(`
      let css = '';
      for (const sheet of Array.from(document.styleSheets)) {
        try { css += Array.from(sheet.cssRules).map((r) => r.cssText).join('\\n'); } catch {}
      }
      const modal = document.querySelector('.promise-modal');
      return {
        len: css.length,
        sheets: document.styleSheets.length,
        thumb: css.includes('scrollbar-thumb'),
        track: css.includes('scrollbar-track'),
        color: css.includes('scrollbar-color'),
        modalRadius: modal ? getComputedStyle(modal).borderRadius : 'n/a',
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    `)
    check(
      '#1 滚动条：轨道透明 + 半透明圆角滑块（主题化规则已生效）',
      scroll && scroll.thumb && scroll.track && scroll.color,
      scroll,
    )
  }

  // --- #3 gtp 技能 -------------------------------------------------------
  console.log('[step] #3 gtp 精密计算')
  {
    const armor = await ev(`
      const g = window.__CONNECT4__;
      await T.start('gtp', 'deepseek');
      T.prep(0, [0]);
      const e = g.engine.value;
      const before = e.current;
      g.toggleSkill(0, 0);
      await T.act(0);
      await T.settle();
      return { before, after: e.current, armor: e.tempArmor[0], cap: g.matchHpCap.value, until: e.tempArmorUntil[0], turnNo: e.turnNo };
    `)
    check(
      '#3 gtp 精密计算：护甲 = 生命上限、用完不交回合、持续到自己的下个回合结束前',
      armor && armor.armor === armor.cap && armor.after === armor.before && armor.until >= armor.turnNo + 3,
      armor,
    )
  }

  console.log('[step] #3 gtp 恶龙吐息')
  {
    const fire = await ev(`
      const g = window.__CONNECT4__;
      await T.start('gtp', 'deepseek');
      const e = g.engine.value;
      e.current = 0;
      g.syncUi();
      g.toggleSkill(0, 1);        // 首次免费 → 直接进"点目标"
      await T.act(40);
      await T.settle();
      return {
        current: e.current,
        flames: e.flames.size,
        fx: g.ui.fireScreen,
        dom: Boolean(document.querySelector('.screen-fx--fire')),
        // bugv30 #4：椭圆遮罩已换成"环绕屏幕一圈的火舌"
        tongues: document.querySelectorAll('.fire-tongue').length,
        ring: Boolean(document.querySelector('.screen-fx__ring')),
      };
    `)
    check(
      '#3 gtp 恶龙吐息：免费火球点燃烈焰 + 全屏火红演出（bugv32 去掉环绕火舌，只剩火红渐晕）',
      fire && fire.current === 0 && fire.flames > 0 && fire.fx > 0 && fire.dom && fire.tongues === 0,
      fire,
    )
    await shot('1-fire-screen')
  }

  console.log('[step] #4 火红自动熄灭')
  {
    await sleep(3500)
    const gone = await ev(
      `const g = window.__CONNECT4__; return { fx: g.ui.fireScreen, dom: Boolean(document.querySelector('.screen-fx--fire')) };`,
    )
    check('#4 火红演出约 3.4 秒后自动熄灭', gone && gone.fx === 0 && !gone.dom, gone)
  }

  // --- #4 护盾镜面反光 ---------------------------------------------------
  console.log('[step] #4 护盾镜面反光')
  {
    const gloss = await ev(`
      const g = window.__CONNECT4__;
      await T.start('deepseek', 'deepseek');
      T.prep(0, [0]);
      g.toggleSkill(0, 0);        // 「大胃袋」：护盾 +1
      await T.act(0);
      await T.settle();
      return {
        flash: g.ui.shieldFlash[0],
        shield: g.engine.value.shield[0],
        dom: Boolean(document.querySelector('[data-player-panel="0"] .portrait__gloss')),
        glossAll: document.querySelectorAll('.portrait__gloss').length,
        panels: document.querySelectorAll('[data-player-panel]').length,
      };
    `)
    check('#4 获得护盾 → 立绘镜面反光（2 秒）', gloss && gloss.flash > 0 && gloss.shield > 0 && gloss.dom, gloss)
    await shot('2-shield-gloss')
  }

  console.log('[step] #4 反光 2 秒后收起')
  {
    await sleep(2200)
    const gone = await ev(
      `return { dom: Boolean(document.querySelector('[data-player-panel="0"] .portrait__gloss')) };`,
    )
    check('#4 镜面反光 2 秒后收起', gone && !gone.dom, gone)
  }

  // --- #4 deepseek 杀鲸霸拳：速度线 --------------------------------------
  console.log('[step] #4 杀鲸霸拳速度线')
  {
    const speed = await ev(`
      const g = window.__CONNECT4__;
      await T.start('deepseek', 'deepseek');
      const e = g.engine.value;
      const cells = [0, 1, 2];
      for (const cell of cells) {
        e.board[cell] = 1;
        e.magic.set(cell, { cell, kind: 'flower', owner: 0 });
      }
      e.current = 0;
      e.skillReadyAt[0][1] = 0;
      g.syncUi();
      g.toggleSkill(0, 1);
      for (const cell of cells) await T.act(cell);   // 选满 3 棵自动释放
      await T.settle();
      return {
        fx: g.ui.speedLine ? g.ui.speedLine.player : null,
        dom: Boolean(document.querySelector('.screen-fx--speed')),
        lines: document.querySelectorAll('.speed-line').length,
        bonus: e.bonusActions[0],
      };
    `)
    check(
      '#4 杀鲸霸拳 → 速度线出现且获得连下两颗',
      speed && speed.fx === 0 && speed.dom && speed.lines >= 20 && speed.bonus >= 1,
      speed,
    )
    await shot('3-speed-lines')
  }

  console.log('[step] #4 速度线随回合收掉')
  {
    const end = await ev(`
      const g = window.__CONNECT4__;
      // 连下两颗（右下角，和技能消耗用的 0/1/2 连不成线）→ 本回合结束
      for (const cell of [80, 79]) {
        await T.act(cell);
        await T.settle();
      }
      return { fx: g.ui.speedLine, dom: Boolean(document.querySelector('.screen-fx--speed')) };
    `)
    check('#4 没连珠 → 本回合结束速度线就收掉', end && end.fx === null && !end.dom, end)
  }

  // --- #2 对局结束后摘掉"上一步落子"高亮 --------------------------------
  console.log('[step] #2 对局结束摘掉上一步高亮')
  {
    const mark = await ev(`
      const g = window.__CONNECT4__;
      await T.start('deepseek', 'deepseek');
      const e = g.engine.value;
      await T.act(T.firstCell());
      await T.settle();
      const withMark = g.ui.lastMark ? { ...g.ui.lastMark } : null;
      const board = e.board.slice();
      board[0 * 9 + 0] = 1; board[0 * 9 + 1] = 1; board[0 * 9 + 2] = 1;
      board[1 * 9 + 0] = 2;
      e.loadScenario(board, { hp: [8, 1], current: 0, firstPlayer: 0 });
      g.syncUi();
      await T.act(0 * 9 + 3);          // 成线 → 攻击
      await T.settle();
      await T.act(8 * 9 + 8);          // 防守方随便落
      await T.settle();
      return {
        withMark,
        over: Boolean(g.ui.result),
        after: g.ui.lastMark,
        scene: g.scene.value ? g.scene.value.lastMarkInfo : null,
      };
    `)
    check(
      '#2 对局结束后"上一步落子"高亮被摘掉（数据 + 3D）',
      mark && mark.withMark !== null && mark.over && mark.after === null && mark.scene === null,
      mark,
    )
  }

  // --- #4 claude 播种：逐棵长出（0.5 秒时间差） --------------------------
  console.log('[step] #4 claude 播种逐棵长出')
  {
    const seed = await ev(
      `
      const g = window.__CONNECT4__;
      await T.start('claude', 'deepseek');
      const e = g.engine.value;
      // 付账用的两棵植物放远一点，给落点 (0,0) 留空（九宫格 → 4 格）
      for (const cell of [70, 71]) {
        e.board[cell] = 1;
        e.magic.set(cell, { cell, kind: 'flower', owner: 0 });
      }
      e.current = 0;
      e.skillReadyAt[0][1] = 0;
      g.syncUi();
      g.toggleSkill(0, 1);        // 「布局」
      await T.act(70);
      await T.act(71);
      await T.settle();
      // 先等棋盘彻底空闲（**不能** skipAnimations：逐棵 0.5 秒的时差会被快进掉）
      let guard = 0;
      while (g.ui.busy && guard++ < 240) await new Promise((r) => setTimeout(r, 50));
      const before = e.magic.size;
      const t0 = performance.now();
      const p = g.handleCellPick(0 * 9 + 0);   // 角落落子 → 九宫格里 4 格
      await p;
      const elapsed = Math.round(performance.now() - t0);
      return {
        before, after: e.magic.size, grew: e.magic.size - before, elapsed,
        busy: g.ui.busy, screen: g.ui.screen, select: Boolean(g.ui.skillSelect),
      };
    `,
      25000,
    )
    check(
      '#4 claude「布局」：九宫格逐棵长出（4 格 ⇒ 至少 1.5 秒的时差）',
      seed && seed.grew > 0 && seed.elapsed >= 1200,
      seed,
    )
  }
} finally {
  await close()
  server.close()
}

console.log('\n============================= 汇总 =============================')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
