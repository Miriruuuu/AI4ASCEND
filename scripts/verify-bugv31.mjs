#!/usr/bin/env node
/**
 * bugv31 验收探针。
 *
 *   node scripts/verify-bugv31.mjs
 *
 * 覆盖：
 *   #1 火球全屏火红演出（bugv32 起去掉环绕屏幕的火舌，只留火红渐晕）
 *   #2 claude「力大砖飞」破盾扩展到**临时护甲**，并给立绘播「镜面破碎」
 *   #3 gtp「恶龙吐息」可变消耗：1 费档只燃火 / 2 费档直击碎子，两档都不结束回合（bugv33 碎子档 3→2）
 *
 * ⚠️ 与 verify-bugv29 / bugv30 一样：headless 下 3D 动画的 rAF 会被节流，
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

mkdirSync('.shots/bugv31', { recursive: true })
await cdp.send('Page.enable')
const shot = async (name) => {
  const r = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ])
  if (!r) return
  writeFileSync(`.shots/bugv31/${name}.png`, Buffer.from(r.data, 'base64'))
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
    await g.handleCellPick(cell);
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

  // --- #1 火球全屏火红演出（bugv32 起去掉环绕屏幕的火舌） ---------------
  console.log('[step] #1 火球全屏火红演出')
  {
    const fire = await ev(
      `
      const g = window.__CONNECT4__;
      await T.start('gtp', 'deepseek');
      const e = g.engine.value;
      e.current = 0;
      g.syncUi();
      g.toggleSkill(0, 1);              // 首次免费 → 直接进"点目标"
      await T.act(40);
      await T.settle();
      const screen = document.querySelector('.screen-fx--fire');
      return {
        fx: g.ui.fireScreen,
        dom: Boolean(screen),
        tongues: document.querySelectorAll('.fire-tongue').length,
        bg: screen ? getComputedStyle(screen).backgroundImage : 'n/a',
      };
    `,
      30000,
    )
    check(
      '#1 全屏火红演出存在、环绕火舌已移除（只剩火红渐晕）',
      fire && fire.fx > 0 && fire.dom && fire.tongues === 0 && String(fire.bg).includes('radial-gradient'),
      { fx: fire?.fx, dom: fire?.dom, tongues: fire?.tongues },
    )
    await shot('1-fire-flash')
  }

  // --- #2 破盾（护盾 + 临时护甲）+ 立绘镜面破碎 --------------------------
  console.log('[step] #2 破盾 + 镜面破碎')
  {
    const brk = await ev(
      `
      const g = window.__CONNECT4__;
      await T.start('claude', 'gtp');
      const e = g.engine.value;
      T.prep(0, [70]);                 // 力大砖飞（1 费）
      g.toggleSkill(0, 0);
      await T.act(70);                 // 选满 1 棵 → 自动释放
      await T.settle();

      // 摆 3 连补齐成线；对手先攒 3 点护盾 + 8 点临时护甲
      e.board = new Array(81).fill(0);
      e.overlay.clear();
      e.flames.clear();
      e.current = 0;
      e.phase = 'playing';
      e.board[T.cell(1, 1)] = 1;
      e.board[T.cell(1, 2)] = 1;
      e.board[T.cell(1, 3)] = 1;
      e.shield[1] = 3;
      e.tempArmor[1] = 8;
      g.syncUi();

      await T.act(T.cell(1, 4));       // 补成 4 连 → 进入攻击阶段
      await T.settle();

      // 防守方不成线 → 结算伤害并破甲；「镜面破碎」只亮 0.9 秒，所以要边跑边抓
      const pending = g.handleCellPick(T.cell(8, 8));
      let hit = null;
      for (let i = 0; i < 60; i++) {
        g.skipAnimations();
        const el = document.querySelector('.portrait__shatter');
        if (el) {
          const shards = Array.from(el.querySelectorAll('.portrait__shard'));
          hit = {
            shards: shards.length,
            flash: Boolean(el.querySelector('.portrait__shatter-flash')),
            anim: shards[0] ? getComputedStyle(shards[0]).animationName : 'n/a',
            withArt: shards.filter((s) => (s.style.backgroundImage || '').includes('url(')).length,
            armorBreak: g.ui.armorBreak[1],
          };
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      await Promise.race([pending, new Promise((r) => setTimeout(r, 3000))]);
      await T.settle();
      return {
        hit,
        shield: e.shield[1],
        armor: e.tempArmor[1],
        base: e.attack?.baseDamage ?? null,
        armorBreak: g.ui.armorBreak[1],
      };
    `,
      30000,
    )
    check(
      '#2 破盾：一击同时清空对手的护盾与临时护甲',
      brk && brk.shield === 0 && brk.armor === 0 && brk.armorBreak >= 1,
      { shield: brk?.shield, armor: brk?.armor, armorBreak: brk?.armorBreak, base: brk?.base },
    )
    check(
      '#2 立绘「镜面破碎」：8 片带立绘的碎片 + 白光，动画已挂上',
      brk && brk.hit && brk.hit.shards === 8 && brk.hit.flash && brk.hit.withArt === 8 && brk.hit.anim === 'portraitShatter',
      brk?.hit,
    )
  }

  // --- #3 恶龙吐息：两档位（1 费只燃火 / 2 费碎子；都不结束回合） ----------
  console.log('[step] #3 恶龙吐息档位')
  {
    const tier = await ev(
      `
      const g = window.__CONNECT4__;
      const run = async (mode) => {
        await T.start('gtp', 'deepseek');
        const e = g.engine.value;
        const plants = [T.cell(0, 0), T.cell(0, 1), T.cell(0, 2)];
        T.prep(1, plants);
        const free = mode === 'free';
        if (!free) {
          e.skillCasts[0][1] = 1;      // 已经不是首次免费
          e.skillReadyAt[0][1] = 0;
        }
        g.syncUi();
        g.toggleSkill(0, 1);
        const sel = g.ui.skillSelect;
        const setup = sel
          ? { need: sel.need, max: sel.max, stage: sel.stage, hint: g.ui.hint }
          : null;
        if (!sel) return { setup, error: '没有进入技能挑选' };
        if (free) {
          await g.handleCellPick(T.cell(4, 4));   // 免费档（1 费效果）：直接点目标
        } else {
          const take = mode === 'two' ? 2 : 1;
          for (let i = 0; i < take; i++) await g.handleCellPick(plants[i]);
          const midHint = g.ui.hint;
          if (mode === 'two') {
            await g.handleCellPick(T.cell(4, 4));
            await T.settle();
            const afterTwo = { current: e.current, phase: e.phase };
            await T.act(T.cell(6, 6));
            await T.settle();
            return {
              setup,
              midHint,
              afterFire: afterTwo,
              afterPlace: { current: e.current },
              remainingPlants: plants.filter((c) => e.magic.has(c)).length,
            };
          }
          const hintOne = g.ui.hint;
          await g.confirmSkillSelect();
          await g.handleCellPick(T.cell(4, 4));
          await T.settle();
          return {
            setup,
            midHint,
            hintOne,
            afterFire: { current: e.current, phase: e.phase },
            remainingPlants: plants.filter((c) => e.magic.has(c)).length,
          };
        }
        await T.settle();
        return { setup, afterFire: { current: e.current, phase: e.phase } };
      };
      const free = await run('free');
      const one = await run('one');
      const two = await run('two');
      return { free, one, two };
    `,
      45000,
    )

    check(
      '#3 首次免费那一手：不用交植物、按 1 费档、不结束回合',
      tier && tier.free && tier.free.setup && tier.free.setup.need === 0 && tier.free.afterFire?.current === 0,
      tier?.free,
    )
    check(
      '#3 交 1 棵：只燃火不碎子、不结束回合（提示写明"只燃火"）',
      tier &&
        tier.one &&
        tier.one.setup?.need === 1 &&
        tier.one.setup?.max === 2 &&
        tier.one.afterFire?.current === 0 &&
        String(tier?.one?.hintOne ?? '').includes('只燃火'),
      tier?.one,
    )
    check(
      '#3 交 2 棵：直击碎子、不结束回合，放完还能继续落子',
      tier &&
        tier.two &&
        tier.two.afterFire?.current === 0 &&
        tier.two.afterPlace?.current === 1 &&
        String(tier?.two?.midHint ?? '').includes('直击碎子'),
      tier?.two,
    )
    await shot('4-fireball-two')
  }

  // --- 补拍：镜面破碎（碎片只亮 0.78 秒，所以重新触发一次同一条路径，
  //     并且**等到碎片飞到一半**（不透明度落在 0.15~0.8）再截图） ------------------
  {
    const mid = await ev(`
      const g = window.__CONNECT4__;
      g.ui.armorBreak[1] += 1;
      for (let i = 0; i < 60; i++) {
        const s = document.querySelector('.portrait__shatter .portrait__shard');
        if (s) {
          const o = Number(getComputedStyle(s).opacity);
          if (o > 0.15 && o < 0.8) return { opacity: o, transform: getComputedStyle(s).transform };
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return { missed: true };
    `)
    console.log('[step] 镜面破碎补拍：', JSON.stringify(mid))
    await shot('3-portrait-shatter')
  }
} finally {
  await close()
  server.close()
}

console.log('\n============================= 汇总 =============================')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}`)
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
