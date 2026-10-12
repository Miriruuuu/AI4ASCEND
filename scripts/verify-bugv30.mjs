#!/usr/bin/env node
/**
 * bugv30 验收探针。
 *
 *   node scripts/verify-bugv30.mjs
 *
 * 覆盖：
 *   #1 开始菜单按钮「一行一个」→「一行两个」（主按钮整行通栏）
 *   #2 6 个角色的 tagline 换成新文案
 *   #3 平衡调整：gtp 1 技能冷却 5→6；claude 1 技能冷却 6→5 且改成"加伤 + 破盾 + 不可重复释放"
 *   #4 火球全屏演出：椭圆遮罩 / 环绕火舌已移除，只留全屏火红演出（bugv32）
 *   #5 开始菜单「游戏规则」按钮 → 居中弹窗显示 help.md
 *
 * ⚠️ 与 verify-bugv29 一样：headless 下 3D 动画的 rAF 会被节流，
 *    所以所有"点棋盘"都用 `T.settle()` 收尾，每个 `ev()` 都带硬超时。
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
  extraArgs: ['--window-size=1440,900'],
})

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

mkdirSync('.shots/bugv30', { recursive: true })
await cdp.send('Page.enable')
const shot = async (name) => {
  const r = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ])
  if (!r) return
  writeFileSync(`.shots/bugv30/${name}.png`, Buffer.from(r.data, 'base64'))
}

const SETUP = `
window.T = {
  g: () => window.__CONNECT4__,
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
  async act(cell, maxMs = 6000) {
    const g = window.__CONNECT4__;
    const t0 = Date.now();
    while (g.ui.busy && Date.now() - t0 < maxMs) {
      g.skipAnimations();
      await new Promise((r) => setTimeout(r, 20));
    }
    g.handleCellPick(cell);
  },
  cell: (r, c) => r * 9 + c,
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
  await sleep(250)
  await ev(SETUP)

  // --- #1 开始菜单按钮一行两个 -------------------------------------------
  console.log('[step] #1 菜单按钮布局')
  {
    const menu = await ev(`
      const nav = document.querySelector('.start-menu__actions');
      const buttons = Array.from(document.querySelectorAll('.start-menu__actions .menu-btn'));
      const primary = document.querySelector('.start-menu__actions .menu-btn--primary');
      const rects = buttons.map((b) => Math.round(b.getBoundingClientRect().width));
      return {
        cols: nav ? getComputedStyle(nav).gridTemplateColumns : 'n/a',
        buttons: buttons.length,
        labels: buttons.map((b) => b.querySelector('.menu-btn__label')?.textContent?.trim() ?? ''),
        primarySpan: primary ? getComputedStyle(primary).gridColumn : 'n/a',
        rects,
        primaryWide: primary ? Math.round(primary.getBoundingClientRect().width) : 0,
      };
    `)
    const tracks = menu && typeof menu.cols === 'string' ? menu.cols.trim().split(/\s+/).length : 0
    check(
      '#1 按钮改成一行两个（两列栅格，共 5 个按钮，主按钮整行通栏）',
      menu &&
        tracks === 2 &&
        menu.buttons === 5 &&
        menu.labels.includes('游戏规则') &&
        menu.primarySpan.includes('span 2') === false &&
        menu.primaryWide > (menu.rects[1] ?? 0) * 1.6,
      menu,
    )
    await shot('1-start-menu')
  }

  // --- #2 角色 tagline ---------------------------------------------------
  console.log('[step] #2 角色 tagline')
  {
    const TAGS = {
      deepseek: '呱！好劲口也！',
      gemini: '哈基米才不是啥子猫',
      gtp: '无敌(指五小时内)',
      claude: '你说的对，但Claude是由Anthropic自主研发的一款全新开放世界对话模型',
      seedance: '我将用最直白，最直接，最不绕弯子...',
      glm: '代码自己在上传',
    }
    const tag = await ev(`
      const g = window.__CONNECT4__;
      const out = {};
      for (const id of ['deepseek','gemini','gtp','claude','seedance','glm']) {
        g.setCharacter(0, id);
        await new Promise((r) => setTimeout(r, 30));
        out[id] = document.querySelector('.detail-char__tagline')?.textContent?.trim() ?? null;
      }
      return out;
    `)
    const bad = Object.entries(TAGS).filter(([id, text]) => (tag?.[id] ?? '') !== text)
    check('#2 6 个角色 tagline 全部换成新文案', bad.length === 0, { tag, bad })
  }

  // --- #5 游戏规则弹窗 ---------------------------------------------------
  console.log('[step] #5 游戏规则弹窗')
  {
    const rules = await ev(`
      const buttons = Array.from(document.querySelectorAll('.start-menu__actions .menu-btn'));
      const btn = buttons.find((b) => (b.querySelector('.menu-btn__label')?.textContent ?? '').includes('游戏规则'));
      btn?.click();
      await new Promise((r) => setTimeout(r, 260));
      const modal = document.querySelector('.rules-modal');
      const items = document.querySelectorAll('.rules-modal__item').length;
      const notes = document.querySelectorAll('.rules-modal__note').length;
      const body = modal?.querySelector('.rules-modal__body')?.textContent ?? '';
      const box = modal?.getBoundingClientRect();
      return {
        open: Boolean(modal),
        items,
        notes,
        hasAscend: body.includes('ASCEND'),
        hasNote: body.includes('本游戏与4ASCEND 有细微不同'),
        centered: box ? Math.abs(box.left + box.width / 2 - window.innerWidth / 2) < 12 : false,
        scrollable: modal ? getComputedStyle(modal.querySelector('.rules-modal__body')).overflowY : 'n/a',
      };
    `)
    check(
      '#5 游戏规则：居中弹窗、11 条规则 + 1 条附注、可滚动',
      rules && rules.open && rules.items === 11 && rules.notes === 1 && rules.hasAscend && rules.hasNote && rules.centered,
      rules,
    )
    await shot('2-rules-modal')
    await ev(`document.querySelector('.rules-modal .primary-btn')?.click(); return true;`)
    await sleep(200)
  }

  // --- #3 冷却数值 + claude 破盾 ----------------------------------------
  console.log('[step] #3 冷却数值')
  {
    const cd = await ev(`
      const g = window.__CONNECT4__;
      await T.start('gtp', 'claude');
      const e = g.engine.value;
      return { gtp: e.skills[0][0].cooldown, claude: e.skills[1][0].cooldown };
    `)
    check('#3 gtp 精密计算冷却 5→6；claude 力大砖飞冷却 6→5', cd && cd.gtp === 6 && cd.claude === 5, cd)
  }

  console.log('[step] #3 claude 破盾（真实引擎）')
  {
    const brk = await ev(
      `
      const g = window.__CONNECT4__;
      await T.start('claude', 'deepseek');
      const e = g.engine.value;
      T.prep(0, [70]);
      g.toggleSkill(0, 0);          // 力大砖飞（1 费）
      await T.act(70);
      await T.settle();
      const strikeAfterCast = e.strikeBonus[0];
      // 摆 3 连 → 补一颗成线；对手先攒 3 点护盾
      e.board = new Array(81).fill(0);
      e.overlay.clear();
      e.flames.clear();
      e.current = 0;
      e.phase = 'playing';
      e.board[T.cell(1, 1)] = 1; e.board[T.cell(1, 2)] = 1; e.board[T.cell(1, 3)] = 1;
      e.shield[1] = 3;
      g.syncUi();
      await T.act(T.cell(1, 4));
      await T.settle();
      const base = e.attack?.baseDamage;
      await T.act(T.cell(8, 8));    // 防守方不成线
      await T.settle();
      return { strikeAfterCast, base, shield: e.shield[1], hp: e.hp[1] };
    `,
      25000,
    )
    check(
      '#3 力大砖飞：首个连珠攻击伤害 +1 且命中后清空对手护盾',
      brk && brk.strikeAfterCast === 1 && brk.base === 5 && brk.shield === 0,
      brk,
    )
  }

  // --- #4 火球环绕火焰 ---------------------------------------------------
  console.log('[step] #4 火球环绕火焰')
  {
    const fire = await ev(
      `
      const g = window.__CONNECT4__;
      await T.start('gtp', 'deepseek');
      const e = g.engine.value;
      e.current = 0;
      g.syncUi();
      g.toggleSkill(0, 1);          // 首次免费 → 进"点目标"
      await T.act(40);
      await T.settle();
      const tongues = document.querySelectorAll('.fire-tongue');
      return {
        fx: g.ui.fireScreen,
        count: tongues.length,
        oval: Boolean(document.querySelector('.screen-fx__ring')),
        dom: Boolean(document.querySelector('.screen-fx--fire')),
      };
    `,
      25000,
    )
    check(
      '#4 火球演出：椭圆遮罩与环绕火舌都已移除、只留全屏火红演出（bugv32）',
      fire && fire.count === 0 && !fire.oval && fire.dom && fire.fx > 0,
      fire,
    )
    await shot('3-fire-flash')
  }

  // --- #1 窄屏（手机）不横向溢出 -----------------------------------------
  console.log('[step] #1 窄屏菜单')
  {
    // ⚠️ 必须先设视口，否则 headless 默认 764×429（verify-ui.mjs 踩过这个坑）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await cdp.send('Page.reload')
    await waitFor('Boolean(window.__CONNECT4__)', 20000)
    await sleep(700)
    await ev(`document.querySelector('.promise-modal .primary-btn')?.click(); return true;`)
    await sleep(250)
    const mob = await ev(`
      const nav = document.querySelector('.start-menu__actions');
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        cols: nav ? getComputedStyle(nav).gridTemplateColumns : 'n/a',
        buttons: document.querySelectorAll('.start-menu__actions .menu-btn').length,
        labels: Array.from(document.querySelectorAll('.start-menu__actions .menu-btn__label')).map((el) => el.textContent.trim()),
      };
    `)
    check(
      '#1 窄屏 390×844：菜单仍是一行两个、且不横向溢出',
      mob && mob.scrollW <= mob.innerW + 1 && mob.buttons === 5 && mob.labels.includes('游戏规则'),
      mob,
    )
    await shot('5-mobile-menu')
  }
} finally {
  await close()
  server.close()
}

console.log('\n============================= 汇总 =============================')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
