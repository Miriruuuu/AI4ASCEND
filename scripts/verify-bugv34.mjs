#!/usr/bin/env node
/**
 * bugv34 验收探针。
 *
 *   npx vite build && node scripts/verify-bugv34.mjs
 *
 * 覆盖：
 *   #1 血量上限默认 12（单机跟随设置）
 *   #2 非联机开局血量 = 血量上限；改成 8 后新局生效
 *   #3 黑夜预告：回合标识上方显示"黑夜即将降临 · 剩余 N 回合"
 *   #4 天气 chip：棋盘下方居中显示天气，点击弹出详情
 *
 * ⚠️ headless 下 3D 动画的 rAF 会被节流，所有 `ev()` 一律带硬超时。
 */
import { existsSync } from 'node:fs'
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

// 清掉本地保存的血量上限 / 黑夜开局，回到默认
await ev(`localStorage.removeItem('connect4.hp.v1'); localStorage.removeItem('connect4.nightStart.v1'); return true;`)

// --- #1 默认上限 = 12 -------------------------------------------------------
const info = await ev(`
  const g = window.__CONNECT4__;
  return { limit: g.ui.hpLimit, cap: g.matchHpCap.value };
`)
check('#1 血量上限默认 12（非联机跟随设置）', info && info.limit === 12 && info.cap === 12, info)

// --- #2 开局血量 = 上限；改成 8 后新局生效 ----------------------------------
const start = await ev(`
  const g = window.__CONNECT4__;
  g.ui.mode = 'pve';
  await g.startMatch();
  await new Promise((r) => setTimeout(r, 500));
  const a = { hp: [g.engine.value.hp[0], g.engine.value.hp[1]], cap: g.matchHpCap.value };
  g.setHpLimit(8);
  await g.startMatch();
  await new Promise((r) => setTimeout(r, 500));
  const b = { hp: [g.engine.value.hp[0], g.engine.value.hp[1]], cap: g.matchHpCap.value, limit: g.ui.hpLimit };
  return { a, b };
`)
check(
  '#2 开局血量 = 血量上限：默认 12 → 改成 8 后新局用 8',
  start && start.a && start.a.hp[0] === 12 && start.a.hp[1] === 12 && start.b && start.b.hp[0] === 8 && start.b.hp[1] === 8,
  start,
)

// --- #3 黑夜预告 ------------------------------------------------------------
const warn = await ev(`
  const g = window.__CONNECT4__;
  g.ui.nightPhase = 'pending';
  g.ui.nightCountdown = 2;
  await new Promise((r) => setTimeout(r, 400));
  const el = document.querySelector('.night-warning');
  return { text: el ? el.textContent.trim() : null, visible: Boolean(el && el.offsetParent !== null) };
`)
check(
  '#3 黑夜预告显示在回合标识上方（"黑夜即将降临 · 剩余 2 回合"）',
  warn && warn.visible && typeof warn.text === 'string' && warn.text.includes('黑夜即将降临') && warn.text.includes('2'),
  warn,
)

// --- #4 天气 chip + 详情 ----------------------------------------------------
const weather = await ev(`
  const g = window.__CONNECT4__;
  g.ui.nightPhase = 'active';
  g.ui.weather = 'thunder';
  await new Promise((r) => setTimeout(r, 400));
  const chip = document.querySelector('.weather-chip');
  const before = { text: chip ? chip.textContent.trim() : null, color: chip ? getComputedStyle(chip).color : null };
  if (chip) chip.click();
  await new Promise((r) => setTimeout(r, 400));
  const detail = document.querySelector('.weather-detail__body');
  return { before, detail: detail ? detail.textContent.trim() : null };
`)
check(
  '#4 天气文字居中显示（雷暴）+ 点击弹出详情（含"污染体"）',
  weather &&
    weather.before &&
    weather.before.text === '雷暴' &&
    typeof weather.detail === 'string' &&
    weather.detail.includes('污染体'),
  weather,
)

// --- #5 生成偏好设置在设置面板里存在 ---------------------------------------
const spawn = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = true;
  await new Promise((r) => setTimeout(r, 400));
  const tabs = [...document.querySelectorAll('.settings-nav__label')].map((el) => el.textContent.trim());
  // 点到"对局"分节，检查有"血量上限"
  const matchBtn = [...document.querySelectorAll('.settings-nav__item')].find((el) => el.textContent.includes('对局'));
  if (matchBtn) matchBtn.click();
  await new Promise((r) => setTimeout(r, 300));
  const text = document.querySelector('.settings-pane')?.textContent ?? '';
  return { tabs, hasHp: text.includes('血量上限'), has162: text.includes('16') };
`)
check(
  '#5 设置面板「对局」分节含「血量上限」（8/12/16）',
  spawn && spawn.hasHp && spawn.has162,
  spawn,
)

// --- #6 黑夜视觉：只压暗"场地"，不染色棋子 --------------------------------
const night = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = false;
  g.ui.mode = 'pve';
  g.scene.value?.setNight(true);
  g.ui.nightPhase = 'active';
  await new Promise((r) => setTimeout(r, 500));
  const appRoot = document.querySelector('.app-root');
  const after = appRoot ? getComputedStyle(appRoot, '::after') : null;
  const sc = g.scene.value;
  const fx = sc && (sc.effects || null);
  const lights = fx ? [fx.ambient, fx.key, fx.fill, fx.rim].filter(Boolean).map((l) => l.color.getHexString()) : null;
  return {
    isNight: Boolean(appRoot && appRoot.classList.contains('is-night')),
    overlayOpacity: after ? after.opacity : null,
    lights,
  };
`)
const lightsNeutral =
  night &&
  Array.isArray(night.lights) &&
  night.lights.length === 4 &&
  night.lights.every((hex) => hex === 'ffffff' || hex === 'dfe6f5')
check(
  '#6 黑夜：场地压暗层生效（is-night + 覆盖层不透明），且 3D 光源保持中性（棋子不被染成深红）',
  night && night.isNight && night.overlayOpacity === '1' && lightsNeutral,
  night,
)

// --- #7 闪电演出分支可执行 --------------------------------------------------
const lightning = await ev(`
  const g = window.__CONNECT4__;
  const sc = g.scene.value;
  if (!sc || typeof sc.playEvents !== 'function') return { ok: false, why: 'scene 不可用' };
  try {
    await sc.playEvents([{ type: 'lightningStruck', cells: [40] }]);
    return { ok: true };
  } catch (error) {
    return { ok: false, why: String(error && error.message ? error.message : error) };
  }
`)
check('#7 雷暴「闪电从天而降」演出分支可执行（lightningStruck → scene）', lightning && lightning.ok, lightning)

// --- #8 黑夜开局（默认关闭；开启后新局直接进入黑夜） ----------------------
const nightStart = await ev(`
  const g = window.__CONNECT4__;
  const before = g.ui.nightConfig.startInNight;
  g.ui.mode = 'pve';
  g.setNightConfig({ startInNight: true });
  await g.startMatch();
  await new Promise((r) => setTimeout(r, 600));
  const engine = g.engine.value;
  const result = {
    defaultOff: before === false,
    flagOn: g.ui.nightConfig.startInNight === true,
    phase: engine.nightPhase,
    weather: engine.weather,
    uiPhase: g.ui.nightPhase,
  };
  g.setNightConfig({ startInNight: false });
  return result;
`)
check(
  '#8 「黑夜开局」默认关闭；开启后新局直接进入黑夜（nightPhase=active 且有天气）',
  nightStart &&
    nightStart.defaultOff &&
    nightStart.flagOn &&
    nightStart.phase === 'active' &&
    typeof nightStart.weather === 'string' &&
    nightStart.uiPhase === 'active',
  nightStart,
)

// --- #9 「黑夜开局」每局天气不固定 ------------------------------------------
const nightly = await ev(`
  const g = window.__CONNECT4__;
  const Engine = g.engine.value.constructor;
  const seen = new Set();
  for (let seed = 1; seed <= 16; seed += 1) {
    const e = new Engine({ fixedFirstPlayer: 0, seed, night: { enabled: true, startInNight: true } });
    e.takeEvents();
    if (e.weather) seen.add(e.weather);
  }
  return { distinct: seen.size, list: [...seen] };
`)
check(
  '#9 「黑夜开局」天气不再恒为一种（16 个种子至少抽出 2 种）',
  nightly && nightly.distinct > 1,
  nightly,
)

// --- #10 瘟疫：带植物的攻击棋子分裂给防守方 --------------------------------
const plague = await ev(`
  const g = window.__CONNECT4__;
  const Engine = g.engine.value.constructor;
  const id = (r, c) => r * 9 + c;
  const mk = (plague) => {
    const e = new Engine({ fixedFirstPlayer: 0, initialHp: 8 });
    e.setFirstPlayer(0);
    e.takeEvents();
    const board = new Array(81).fill(0);
    board[id(1, 1)] = 1; board[id(1, 2)] = 1; board[id(1, 3)] = 1;
    e.loadScenario(board, { hp: [8, 8], current: 0, firstPlayer: 0 });
    e.magic.set(id(1, 1), { cell: id(1, 1), kind: 'flower', owner: 0 });
    e.weather = plague ? 'plague' : null;
    e.nightPhase = plague ? 'active' : 'none';
    const declared = e.commit(id(1, 4));
    const finalAttack = e.attack.finalAttack;
    // 攻击阶段刚开、防守方还没下子 → 防守方就该已经握有分裂来的棋子
    const defenderAttackAtDeclare = e.attack.defenderAttack;
    const splitAtDeclare = declared.some((x) => x.type === 'attackStoneSplit');
    const events = e.defend(id(8, 8));
    const snap = events.find((x) => x.type === 'attackResolved').snapshot;
    return {
      finalAttack,
      defenderAttackAtDeclare,
      splitAtDeclare,
      defenderAttack: snap.defenderAttack,
      diff: snap.diff,
      hp1: e.hp[1],
    };
  };
  return { on: mk(true), off: mk(false) };
`)
check(
  '#10 瘟疫：攻击方连珠上的植物**在攻击阶段开启时**就把分裂棋子挂给防守方（落子前即可见，伤害被削弱）',
  plague &&
    plague.on &&
    plague.off &&
    plague.on.finalAttack === 5 &&
    plague.on.defenderAttackAtDeclare === 1 &&
    plague.on.splitAtDeclare === true &&
    plague.on.defenderAttack === 1 &&
    plague.on.diff === 4 &&
    plague.on.hp1 === 4 &&
    plague.off.defenderAttackAtDeclare === 0 &&
    plague.off.splitAtDeclare === false &&
    plague.off.defenderAttack === 0 &&
    plague.off.hp1 === 3,
  plague,
)

// --- #11 瘟疫（对称方向）：防守方成线反击时，防守方的植物也给攻击方补棋子 ----
const plagueSymmetric = await ev(`
  const g = window.__CONNECT4__;
  const Engine = g.engine.value.constructor;
  const id = (r, c) => r * 9 + c;
  const mk = (plague) => {
    const e = new Engine({ fixedFirstPlayer: 0, initialHp: 8 });
    e.setFirstPlayer(0);
    e.takeEvents();
    const board = new Array(81).fill(0);
    board[id(1, 1)] = 1; board[id(1, 2)] = 1; board[id(1, 3)] = 1;
    board[id(8, 1)] = 2; board[id(8, 2)] = 2; board[id(8, 3)] = 2;
    e.loadScenario(board, { hp: [8, 8], current: 0, firstPlayer: 0 });
    // 只有防守方连珠上有植物
    e.magic.set(id(8, 2), { cell: id(8, 2), kind: 'grass', owner: 1 });
    e.weather = plague ? 'plague' : null;
    e.nightPhase = plague ? 'active' : 'none';
    e.commit(id(1, 4));
    const events = e.defend(id(8, 4));
    const snap = events.find((x) => x.type === 'attackResolved').snapshot;
    const toAttacker = events.some((x) => x.type === 'attackStoneSplit' && x.to === 0);
    return { finalAttack: snap.finalAttack, defenderAttack: snap.defenderAttack, diff: snap.diff, toAttacker };
  };
  return { on: mk(true), off: mk(false) };
`)
check(
  '#11 瘟疫对称：防守方成线反击时，防守方连珠上的植物补一颗给攻击方（对两边都生效）',
  plagueSymmetric &&
    plagueSymmetric.on &&
    plagueSymmetric.off &&
    plagueSymmetric.on.finalAttack === 5 &&
    plagueSymmetric.on.defenderAttack === 5 &&
    plagueSymmetric.on.diff === 0 &&
    plagueSymmetric.on.toAttacker === true &&
    plagueSymmetric.off.finalAttack === 4 &&
    plagueSymmetric.off.toAttacker === false,
  plagueSymmetric,
)

// --- #12 对局内天气「描述」= Weather.md 的口径 ------------------------------
const weatherTexts = await ev(`
  const g = window.__CONNECT4__;
  const want = {
    thunder: '魔力植物转变为污染体，为最终伤害+2。',
    drought: '场上不再生成魔力植物，双方在攻击阶段伤害-1。',
    depletion: '结算伤害时魔力植物不再提供伤害加成。',
    plague: '连珠后魔力植物会为双方提供伤害加成。',
    dryLightning: '魔力植物会遭受雷击。',
    blizzard: '魔力植物会被冻结。',
    aurora: '魔力植物可治愈双方。',
  };
  const out = {};
  // 先确保上一次检查（#4）留下的详情是收起的
  const closeIfOpen = () => {
    const btn = document.querySelector('.weather-detail .icon-btn');
    if (btn) btn.click();
  };
  closeIfOpen();
  await new Promise((r) => setTimeout(r, 250));
  g.ui.nightPhase = 'active';
  for (const id of Object.keys(want)) {
    g.ui.weather = id;
    await new Promise((r) => setTimeout(r, 250));
    let body = document.querySelector('.weather-detail__body');
    if (!body) {
      const chip = document.querySelector('.weather-chip');
      if (chip) chip.click();
      await new Promise((r) => setTimeout(r, 300));
      body = document.querySelector('.weather-detail__body');
    }
    out[id] = body ? body.textContent.trim() : null;
    closeIfOpen();
    await new Promise((r) => setTimeout(r, 200));
    out[id + '_ok'] = out[id] === want[id];
  }
  g.ui.weather = null;
  g.ui.nightPhase = 'none';
  return out;
`)
check(
  '#12 对局内天气「描述」与 Weather.md 一致（7 种全部）',
  weatherTexts &&
    ['thunder', 'drought', 'depletion', 'plague', 'dryLightning', 'blizzard', 'aurora'].every(
      (id) => weatherTexts[id + '_ok'] === true,
    ),
  weatherTexts,
)

// --- #13 干涸：−1 只算一次 + 防守方也生效 + 连珠格植物不残留 ------------------
const drought = await ev(`
  const g = window.__CONNECT4__;
  const Engine = g.engine.value.constructor;
  const id = (r, c) => r * 9 + c;
  const board = new Array(81).fill(0);
  board[id(1, 1)] = 1; board[id(1, 2)] = 1; board[id(1, 3)] = 1;
  const mk = (weather, rows, hp) => {
    const e = new Engine({ fixedFirstPlayer: 0, initialHp: 12 });
    e.setFirstPlayer(0);
    e.takeEvents();
    const b = new Array(81).fill(0);
    for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) b[id(r, c)] = rows[r][c] === 'R' ? 1 : rows[r][c] === 'B' ? 2 : 0;
    e.loadScenario(b, { hp: hp ?? [12, 12], current: 0, firstPlayer: 0 });
    e.weather = weather;
    e.nightPhase = weather ? 'active' : 'none';
    return e;
  };
  const E = '.........', R = '.RRR.....', B = '.BBB.....';
  // ① 无植物：4 连 → 3（不是 2）
  const plain = mk('drought', [E, R, E, E, E, E, E, E, E]);
  plain.commit(id(1, 4));
  const plainFinal = plain.attack.finalAttack;
  const plainSnap = plain.defend(id(8, 8)).find((x) => x.type === 'attackResolved').snapshot;
  // ② 连珠格上有植物：结算后不留残渣
  const withPlant = mk('drought', [E, R, E, E, E, E, E, E, E]);
  const line = [id(1, 1), id(1, 2), id(1, 3), id(1, 4)];
  for (const cell of line) withPlant.magic.set(cell, { cell, kind: 'flower', owner: 0 });
  withPlant.commit(id(1, 4));
  withPlant.defend(id(8, 8));
  const residue = line.filter((cell) => withPlant.magic.has(cell)).length;
  // ③ 防守方成线反击同样 −1
  const counter = mk('drought', [E, R, E, E, E, E, E, E, B]);
  const attackEvents = counter.commit(id(1, 4));
  const defendEvents = counter.defend(id(8, 4));
  const counterSnap = defendEvents.find((x) => x.type === 'attackResolved').snapshot;
  // ④ bugv34d：不再发"碎一颗"事件（否则 3D 会在舞台上凭空补一颗再炸，与对账重复播两遍）
  const shattered = [...attackEvents, ...defendEvents].some((x) => x.type === 'attackStoneShattered');
  return {
    plainFinal,
    plainDiff: plainSnap.diff,
    residue,
    counterFinal: counterSnap.finalAttack,
    counterDefender: counterSnap.defenderAttack,
    shattered,
  };
`)
check(
  '#13 干涸：4 连只 −1（→3，不是 2）、防守方反击同样 −1、连珠格植物不残留、不再发"碎一颗"事件',
  drought &&
    drought.plainFinal === 3 &&
    drought.plainDiff === 3 &&
    drought.residue === 0 &&
    drought.counterFinal === 3 &&
    drought.counterDefender === 3 &&
    drought.shattered === false,
  drought,
)

// --- #14~#16 三种新天气（暴雪 / 极光 / 旱雷） --------------------------------
const newWeathers = await ev(`
  const g = window.__CONNECT4__;
  const Engine = g.engine.value.constructor;
  const id = (r, c) => r * 9 + c;
  const E = '.........', R = '.RRR.....';
  const mk = (weather, hp) => {
    const e = new Engine({ fixedFirstPlayer: 0, initialHp: 12 });
    e.setFirstPlayer(0);
    e.takeEvents();
    const b = new Array(81).fill(0);
    const rows = [E, R, E, E, E, E, E, E, E];
    for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) b[id(r, c)] = rows[r][c] === 'R' ? 1 : 0;
    e.loadScenario(b, { hp: hp ?? [12, 12], current: 0, firstPlayer: 0 });
    e.weather = weather;
    e.nightPhase = weather ? 'active' : 'none';
    return e;
  };
  // 暴雪：连珠上有 1 棵冻结植物 → 不加伤（4）；连珠后那棵随棋子消失、并在**原地**长出一棵非冻结的
  const blizzard = mk('blizzard');
  blizzard.magic.set(id(1, 1), { cell: id(1, 1), kind: 'frozen', owner: 0 });
  blizzard.commit(id(1, 4));
  const blizzardFinal = blizzard.attack.finalAttack;
  const blizzardEvents = blizzard.defend(id(8, 8));
  const thawRemoved = blizzardEvents.find((x) => x.type === 'magicRemoved' && x.cells.includes(id(1, 1)));
  const thawGrown = blizzardEvents.find(
    (x) => x.type === 'magicGrown' && x.plants.some((p) => p.cell === id(1, 1)),
  );
  const thawPlant = blizzard.magic.get(id(1, 1));
  // 极光：2 棵植物 → 双方各回 2
  const aurora = mk('aurora', [6, 6]);
  aurora.magic.set(id(1, 1), { cell: id(1, 1), kind: 'flower', owner: 0 });
  aurora.magic.set(id(1, 2), { cell: id(1, 2), kind: 'grass', owner: 0 });
  aurora.commit(id(1, 4));
  const auroraHp = [aurora.hp[0], aurora.hp[1]];
  // 旱雷：落子后雷击自己占用的一棵植物，并在空位补长一棵
  const dry = mk('dryLightning');
  dry.magic.set(id(5, 5), { cell: id(5, 5), kind: 'grass', owner: 0 });
  const dryBefore = dry.magic.size;
  const dryEvents = dry.commit(id(0, 0));
  const struck = dryEvents.find((x) => x.type === 'lightningStruck');
  const removed = dryEvents.find((x) => x.type === 'magicRemoved' && x.reason === 'weather');
  const grown = dryEvents.find((x) => x.type === 'magicGrown');
  return {
    blizzardFinal,
    thawed:
      Boolean(thawRemoved) &&
      Boolean(thawGrown) &&
      thawGrown.source === 'weather' &&
      thawGrown.plants.every((p) => p.cell !== id(1, 1) || p.kind !== 'frozen') &&
      Boolean(thawPlant) &&
      thawPlant.kind !== 'frozen',
    auroraHp,
    struck: Boolean(struck),
    removedCell: removed ? removed.cells[0] : null,
    grownCell: grown ? grown.plants[0].cell : null,
    dryCount: [dryBefore, dry.magic.size],
  };
`)
check(
  '#14 暴雪：冻结植物不加伤（4 连 + 1 冻结 → 4）；连珠后随棋子消失、并在原地长出一棵非冻结的',
  newWeathers && newWeathers.blizzardFinal === 4 && newWeathers.thawed === true,
  newWeathers,
)
check(
  '#15 极光：连珠后双方各回"连珠上植物数"的血（6/6 + 2 棵 → 8/8）',
  newWeathers && Array.isArray(newWeathers.auroraHp) && newWeathers.auroraHp[0] === 8 && newWeathers.auroraHp[1] === 8,
  newWeathers && newWeathers.auroraHp,
)
check(
  '#16 旱雷：落子后雷击自己占用的植物、并在空位补长一棵（总数不变）',
  newWeathers &&
    newWeathers.struck === true &&
    newWeathers.removedCell === 5 * 9 + 5 &&
    typeof newWeathers.grownCell === 'number' &&
    newWeathers.dryCount[0] === newWeathers.dryCount[1],
  newWeathers,
)

// --- #17 设置面板新增「黑夜」分节（进入/结束/强制结束可调） -------------------
const nightTab = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = true;
  await new Promise((r) => setTimeout(r, 400));
  const btn = [...document.querySelectorAll('.settings-nav__item')].find((el) => el.textContent.includes('黑夜'));
  if (!btn) return { hasTab: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const pane = document.querySelector('.settings-pane');
  const text = pane ? pane.textContent : '';
  return {
    hasTab: true,
    fields: pane ? pane.querySelectorAll('.magic-field__input').length : 0,
    hasEnter: text.includes('进入条件'),
    hasExit: text.includes('结束条件'),
    hasForce: text.includes('强制结束'),
    hasStart: text.includes('黑夜开局'),
  };
`)
check(
  '#17 设置面板新增「黑夜」分节：进入条件 / 结束条件 / 强制结束（含数值输入）',
  nightTab && nightTab.hasTab && nightTab.hasEnter && nightTab.hasExit && nightTab.hasForce && nightTab.hasStart && nightTab.fields >= 9,
  nightTab,
)

// --- #18 回放拖进度：黑夜 / 白天要及时切换 ------------------------------------
const replayNight = await ev(`
  const g = window.__CONNECT4__;
  const id = (r, c) => r * 9 + c;
  // 造一份"两步"的假回放：第 1 步白天，第 2 步黑夜
  const E = new Array(81).fill(0);
  const B1 = E.slice(); B1[id(8, 0)] = 1;
  const B2 = B1.slice(); B2[id(8, 1)] = 2;
  const step = (board, hp, nightPhase, weather, extra) => ({
    player: 0, cell: id(8, 0), defense: false, match: false,
    board, hp, magic: [], extra: { nightPhase, nightTurns: nightPhase === 'active' ? 1 : 0, weather, attacksLaunched: [0,0], nightAttackBase: [0,0], ...extra },
  });
  g.replay.record = {
    id: 'verify-night', createdAt: Date.now(), players: ['A', 'B'], characters: ['deepseek', 'gemini'],
    first: 0, result: { winner: 0, reason: 'hp' },
    steps: [step(B1, [12, 12], 'none', null), step(B2, [12, 12], 'active', 'thunder')],
  };
  g.ui.showReplay = true;
  await new Promise((r) => setTimeout(r, 400));
  g.seekReplay(1);
  await new Promise((r) => setTimeout(r, 500));
  const day = {
    root: document.querySelector('.app-root')?.classList.contains('is-night'),
    phase: g.ui.nightPhase,
    weather: g.ui.weather,
    chip: Boolean(document.querySelector('.weather-chip')),
  };
  g.seekReplay(2);
  await new Promise((r) => setTimeout(r, 500));
  const night = {
    root: document.querySelector('.app-root')?.classList.contains('is-night'),
    phase: g.ui.nightPhase,
    weather: g.ui.weather,
    chip: Boolean(document.querySelector('.weather-chip')),
  };
  g.seekReplay(0);
  await new Promise((r) => setTimeout(r, 500));
  const back = {
    root: document.querySelector('.app-root')?.classList.contains('is-night'),
    phase: g.ui.nightPhase,
    weather: g.ui.weather,
  };
  g.ui.showReplay = false;
  g.replay.record = null;
  await new Promise((r) => setTimeout(r, 300));
  return { day, night, back };
`)
check(
  '#18 回放拖到"黑夜那一步"→ 场地立刻转夜（is-night + 天气 chip）；拖回白天/开头 → 立刻退夜',
  replayNight &&
    replayNight.day.root === false &&
    replayNight.night.root === true &&
    replayNight.night.phase === 'active' &&
    replayNight.night.weather === 'thunder' &&
    replayNight.night.chip === true &&
    replayNight.back.root === false &&
    replayNight.back.phase === 'none' &&
    replayNight.back.weather === null,
  replayNight,
)

// --- #19 默认黑夜常量（bugv34d） ---------------------------------------------
const nightDefaults = await ev(`
  const g = window.__CONNECT4__;
  const c = g.ui.nightConfig;
  return {
    warnTurns: c.warnTurns,
    minGap: c.minGap,
    startTurnThreshold: c.startTurnThreshold,
    entryAttackThreshold: c.entryAttackThreshold,
    entryPlantThreshold: c.entryPlantThreshold,
    exitTurnsA: c.exitTurnsA,
    exitAttacksA: c.exitAttacksA,
    exitTurnsB: c.exitTurnsB,
    exitAttacksB: c.exitAttacksB,
  };
`)
check(
  '#19 默认黑夜常量：预告 3 / 间隔 20 / 开局 50 或攻击 10 / 植物 10 / 结束 30+20 / 强制 60+40',
  nightDefaults &&
    nightDefaults.warnTurns === 3 &&
    nightDefaults.minGap === 20 &&
    nightDefaults.startTurnThreshold === 50 &&
    nightDefaults.entryAttackThreshold === 10 &&
    nightDefaults.entryPlantThreshold === 10 &&
    nightDefaults.exitTurnsA === 30 &&
    nightDefaults.exitAttacksA === 20 &&
    nightDefaults.exitTurnsB === 60 &&
    nightDefaults.exitAttacksB === 40,
  nightDefaults,
)

// --- #20 「黑夜开局」的首个黑夜不判"无主植物"退出（bugv34d） -----------------
const openingNight = await ev(`
  const g = window.__CONNECT4__;
  const Engine = g.engine.value.constructor;
  const id = (r, c) => r * 9 + c;
  const mk = (startInNight) => {
    const e = new Engine({ fixedFirstPlayer: 0, initialHp: 12, night: { enabled: true, startInNight } });
    e.setFirstPlayer(0);
    e.takeEvents();
    return e;
  };
  // 开局黑夜：连走几步都不该天亮（开局 0 棵植物）
  const opening = mk(true);
  const phase0 = opening.nightPhase;
  const fromStart = opening.nightFromStart;
  for (let i = 0; i < 6; i += 1) opening.commit(opening.legalMoves()[0]);
  const stillNight = opening.nightPhase;
  // 场上全是"被占有"的植物（0 棵无主）——仍不天亮
  for (let cell = 0; cell < 30; cell += 1) opening.magic.set(cell, { cell, kind: 'grass', owner: 0 });
  opening.commit(opening.legalMoves()[0]);
  const afterOwned = opening.nightPhase;
  // 但真正的强制退出（持续回合）照样生效
  opening.nightTurns = 999;
  const endedEvents = opening.commit(opening.legalMoves()[0]);
  const ended = endedEvents.some((x) => x.type === 'nightEnded');
  return { phase0, fromStart, stillNight, afterOwned, ended, phase: opening.nightPhase };
`)
check(
  '#20 「黑夜开局」首个黑夜不判"无主植物"（不会第一回合天亮），但持续回合的强制退出仍生效',
  openingNight &&
    openingNight.phase0 === 'active' &&
    openingNight.fromStart === true &&
    openingNight.stillNight === 'active' &&
    openingNight.afterOwned === 'active' &&
    openingNight.ended === true &&
    openingNight.phase === 'none',
  openingNight,
)

// --- #21 设置面板「黑夜」分节写出完整规则（含"场上没有被棋子占有的魔力植物"）---
const nightRules = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = true;
  await new Promise((r) => setTimeout(r, 400));
  const btn = [...document.querySelectorAll('.settings-nav__item')].find((el) => el.textContent.includes('黑夜'));
  if (!btn) return { hasTab: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const text = document.querySelector('.settings-pane')?.textContent ?? '';
  const rules = document.querySelector('.settings-pane')?.querySelectorAll('.settings-rules li').length ?? 0;
  return {
    hasTab: true,
    rules,
    hasOwned: text.includes('没有被棋子占有的魔力植物'),
    hasAttackStones: text.includes('攻击棋子'),
    hasWarn: text.includes('预告'),
    hasOpeningNote: text.includes('黑夜开局') && text.includes('不判这一条'),
  };
`)
check(
  '#21 设置面板「黑夜」写出完整规则（含"场上没有被棋子占有的魔力植物"与开局豁免说明）',
  nightRules &&
    nightRules.hasTab &&
    nightRules.rules >= 7 &&
    nightRules.hasOwned &&
    nightRules.hasAttackStones &&
    nightRules.hasWarn &&
    nightRules.hasOpeningNote,
  nightRules,
)

// --- #22 结算面板显示天气增减伤（bugv34e） -----------------------------------
const weatherDeltaUi = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = false;
  g.ui.screen = 'playing';
  g.ui.mode = 'pve';
  g.ui.attackPanelOpen = true;
  g.ui.attack = {
    attacker: 0, defender: 1, baseDamage: 4, lineLengthSum: 4, defenseCell: null, weakness: 0,
    finalAttack: 3, defenderAttack: 0, diff: 3, mode: 'defenderDamaged', damaged: 1,
    attackerPlants: 0, defenderPlants: 0, stolenPlants: 0,
    weather: 'drought', weatherAttackDelta: -1, weatherDefenderDelta: 0,
  };
  await new Promise((r) => setTimeout(r, 350));
  const card = document.querySelector('.attack-card');
  const text = card ? card.textContent : '';
  const weatherStat = [...document.querySelectorAll('.attack-card .stat')].find((el) =>
    el.textContent.includes('干涸'),
  );
  return {
    hasCard: Boolean(card),
    hasWeatherRow: Boolean(weatherStat),
    weatherText: weatherStat ? weatherStat.textContent.replace(/\\s+/g, ' ').trim() : null,
    hasDelta: text.includes('-1'),
  };
`)
check(
  '#22 结算面板显示「天气增减伤」明细（干涸 → −1 单独一行）',
  weatherDeltaUi &&
    weatherDeltaUi.hasCard &&
    weatherDeltaUi.hasWeatherRow &&
    typeof weatherDeltaUi.weatherText === 'string' &&
    weatherDeltaUi.weatherText.includes('-1') &&
    weatherDeltaUi.hasDelta,
  weatherDeltaUi,
)

// --- #23 联机房间（大厅）UI（bugv34e） ---------------------------------------
const roomUi = await ev(`
  const g = window.__CONNECT4__;
  g.ui.attackPanelOpen = false;
  g.ui.attack = null;
  g.ui.mode = 'online';
  g.ui.screen = 'online';
  // bugv34i：未登录时联机面板是登录表单 —— 这里先摆上登录态，才渲染房间
  g.online.user = { username: 'probe', nickname: '探针' };
  g.online.room = {
    code: 'AB12CD',
    you: 'me',
    members: [
      { playerId: 'me', name: '我', character: 'deepseek', connected: true, host: true, wins: 2, ready: true },
      { playerId: 'rival', name: '对手', character: 'gtp', connected: false, host: false, wins: 1, ready: false },
    ],
    settings: {
      hpLimit: 16,
      magic: { enabled: true, cooldownTurns: 10, lineCooldownCut: 8, baseCount: 2, growthStep: 3, maxCount: 4, damagePerPlant: 1, requireLine: false },
      night: { enabled: true, startInNight: false, warnTurns: 3, minGap: 20, startTurnThreshold: 50, entryAttackThreshold: 10, entryPlantThreshold: 10, exitTurnsA: 30, exitAttacksA: 20, exitTurnsB: 60, exitAttacksB: 40 },
    },
    phase: 'lobby',
    matchId: null,
    chat: [{ id: 1, playerId: 'rival', name: '对手', text: '准备好了吗', at: Date.now() }],
    canStart: false,
  };
  g.online.chatOpen = true;
  await new Promise((r) => setTimeout(r, 450));
  const view = document.querySelector('.room-view');
  const text = view ? view.textContent : '';
  const chatPanel = document.querySelector('.room-chat__panel');
  const chatText = chatPanel ? chatPanel.textContent : '';
  const offlineBadge = text.includes('已离线');
  const hostBadge = text.includes('房主');
  const wins = text.includes('2 胜') && text.includes('1 胜');
  // bugv34i：底部是「准备 / 房间设置 / 退出」三个按钮，且不再有「设置 / 返回主菜单」
  const actionBtns = [...document.querySelectorAll('.room-actions .menu-btn')];
  const labels = actionBtns.map((el) => (el.textContent || '').trim());
  const readyBtn = actionBtns.find((el) => (el.textContent || '').includes('准备'));
  const readyBadge = text.includes('已准备');
  return {
    hasView: Boolean(view),
    hasCode: text.includes('AB12CD'),
    offlineBadge,
    hostBadge,
    wins,
    // 对手离线 → 准备按钮不可用
    readyDisabled: readyBtn ? readyBtn.disabled === true : null,
    actionLabels: labels,
    actionCount: actionBtns.length,
    readyBadge,
    noLegacyButtons: !/返回主菜单/.test(text),
    chatOpen: Boolean(chatPanel),
    chatText,
  };
`)
check(
  '#23 房间大厅渲染：房间号 / 房主与离线与"已准备"标记 / 比分 / 底部三按钮(准备|房间设置|退出) / 无"返回主菜单" / 左侧聊天',
  roomUi &&
    roomUi.hasView &&
    roomUi.hasCode &&
    roomUi.offlineBadge &&
    roomUi.hostBadge &&
    roomUi.wins &&
    roomUi.readyBadge &&
    roomUi.actionCount === 3 &&
    roomUi.readyDisabled === true &&
    roomUi.noLegacyButtons &&
    roomUi.chatOpen &&
    roomUi.chatText.includes('准备好了吗'),
  roomUi,
)

// --- #24 房间设置面板（三块 + 只读/可编辑）（bugv34e） ------------------------
const roomSettingsUi = await ev(`
  const g = window.__CONNECT4__;
  const host = { playerId: 'me', name: '我', character: 'deepseek', connected: true, host: true, wins: 0, ready: false };
  const guest = { playerId: 'rival', name: '对手', character: 'gtp', connected: true, host: false, wins: 0, ready: false };
  g.online.room = { ...g.online.room, members: [host, guest], canStart: true };
  await new Promise((r) => setTimeout(r, 300));
  // 点「房间设置」打开弹层
  const btn = [...document.querySelectorAll('.room-view .menu-btn')].find((el) => el.textContent.includes('房间设置'));
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 350));
  const panel = document.querySelector('.room-settings');
  const text = panel ? panel.textContent : '';
  const sections = panel ? panel.querySelectorAll('.room-settings__section').length : 0;
  const inputs = panel ? panel.querySelectorAll('.room-settings__field input').length : 0;
  const firstInput = panel ? panel.querySelector('.room-settings__field input') : null;
  return {
    hasPanel: Boolean(panel),
    sections,
    inputs,
    hasPreference: text.includes('对局偏好') && text.includes('血量上限'),
    hasMagic: text.includes('魔力植物'),
    hasNight: text.includes('黑夜') && text.includes('强制结束'),
    editable: firstInput ? firstInput.disabled === false : false,
  };
`)
check(
  '#24 房间设置面板：对局偏好（血量上限）+ 魔力植物 + 黑夜，房主可编辑',
  roomSettingsUi &&
    roomSettingsUi.hasPanel &&
    roomSettingsUi.sections >= 3 &&
    roomSettingsUi.inputs >= 10 &&
    roomSettingsUi.hasPreference &&
    roomSettingsUi.hasMagic &&
    roomSettingsUi.hasNight &&
    roomSettingsUi.editable === true,
  roomSettingsUi,
)

// --- #25 非房主也能查看房间设置（只读）（bugv34i） --------------------------
const guestSettingsUi = await ev(`
  const g = window.__CONNECT4__;
  const host = { playerId: 'rival', name: '对手', character: 'gtp', connected: true, host: true, wins: 0, ready: true };
  const guest = { playerId: 'me', name: '我', character: 'deepseek', connected: true, host: false, wins: 0, ready: true };
  g.online.room = { ...g.online.room, members: [host, guest], canStart: true };
  await new Promise((r) => setTimeout(r, 250));
  // 非房主：先关掉再重新打开，确认按钮可点
  const closeBtn = document.querySelector('.room-settings__head .icon-btn');
  if (closeBtn) closeBtn.click();
  await new Promise((r) => setTimeout(r, 200));
  const btn = [...document.querySelectorAll('.room-actions .menu-btn')].find((el) => el.textContent.includes('房间设置'));
  const clickable = btn ? btn.disabled === false : false;
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const panel = document.querySelector('.room-settings');
  const firstInput = panel ? panel.querySelector('.room-settings__field input') : null;
  return {
    clickable,
    hasPanel: Boolean(panel),
    readOnly: firstInput ? firstInput.disabled === true : false,
  };
`)
check(
  '#25 非房主也能查看房间设置（只读）：按钮可点、面板可开、输入框禁用',
  guestSettingsUi && guestSettingsUi.clickable && guestSettingsUi.hasPanel && guestSettingsUi.readOnly,
  guestSettingsUi,
)

// --- #26 未登录时联机面板：账号 / 密码 + 底部两按钮；账号不存在才展开昵称 ---
const authUi = await ev(`
  const g = window.__CONNECT4__;
  g.online.user = null;
  g.online.room = null;
  g.ui.screen = 'online';
  g.online.authMode = 'login';
  g.online.authMessage = '';
  await new Promise((r) => setTimeout(r, 300));
  const panel = document.querySelector('.auth-panel');
  const text = panel ? panel.textContent : '';
  const inputs = panel ? panel.querySelectorAll('.auth-field__input').length : 0;
  // 底部并排两个按钮
  const actions = panel ? [...panel.querySelectorAll('.auth-panel__actions .menu-btn')] : [];
  const actionLabels = actions.map((b) => (b.textContent || '').trim());
  const actionTops = actions.map((b) => Math.round(b.getBoundingClientRect().top));
  // 不应该再有"登录 / 注册"切换
  const segButtons = panel ? panel.querySelectorAll('.segmented button').length : -1;
  // 输入框加高（>40px 才算"大气"）
  const inputH = panel ? Math.round(panel.querySelector('.auth-field__input').getBoundingClientRect().height) : 0;
  // 模拟"账号不存在"→ 父组件把 authMode 切到 register
  g.online.authMode = 'register';
  await new Promise((r) => setTimeout(r, 250));
  const regInputs = panel.querySelectorAll('.auth-field__input').length;
  const regText = panel.textContent;
  const regInputH = Math.round(panel.querySelectorAll('.auth-field__input')[2].getBoundingClientRect().height);
  return {
    hasPanel: Boolean(panel),
    loginInputs: inputs,
    hasAccount: text.includes('账号') && text.includes('密码'),
    segButtons,
    actionCount: actions.length,
    actionLabels,
    actionsSameRow: new Set(actionTops).size === 1,
    inputH,
    regInputs,
    regHasNickname: regText.includes('昵称'),
    regInputH,
  };
`)
check(
  '#26 登录面板：账号 / 密码（无切换按钮）+ 底部并排[登录|返回主菜单] + 输入框加高；账号不存在 → 展开昵称',
  authUi &&
    authUi.hasPanel &&
    authUi.loginInputs === 2 &&
    authUi.hasAccount &&
    authUi.segButtons === 0 &&
    authUi.actionCount === 2 &&
    authUi.actionsSameRow &&
    authUi.inputH >= 44 &&
    authUi.regInputs === 3 &&
    authUi.regHasNickname &&
    authUi.regInputH >= 44,
  authUi,
)

// --- #27 房间内"我的角色"右侧带技能详情（与单机同款）（bugv34k） ------------
const deckUi = await ev(`
  const g = window.__CONNECT4__;
  g.online.user = { username: 'probe', nickname: '探针' };
  g.online.room = {
    code: 'AB12CD', you: 'me',
    members: [
      { playerId: 'me', name: '我', character: 'deepseek', connected: true, host: true, wins: 0, ready: false },
      { playerId: 'rival', name: '对手', character: 'gtp', connected: true, host: false, wins: 0, ready: false },
    ],
    settings: {
      hpLimit: 12,
      magic: { enabled: true, cooldownTurns: 10, lineCooldownCut: 8, baseCount: 2, growthStep: 3, maxCount: 4, damagePerPlant: 1, requireLine: false },
      night: { enabled: false, startInNight: false, warnTurns: 3, minGap: 20, startTurnThreshold: 50, entryAttackThreshold: 10, entryPlantThreshold: 10, exitTurnsA: 30, exitAttacksA: 20, exitTurnsB: 60, exitAttacksB: 40 },
    },
    phase: 'lobby', matchId: null, chat: [], canStart: false,
  };
  await new Promise((r) => setTimeout(r, 400));
  const layout = document.querySelector('.room-deck-layout');
  const main = document.querySelector('.room-deck-layout .room-deck-main');
  const picker = document.querySelector('.room-deck-layout .character-picker');
  const detail = document.querySelector('.room-deck-layout .character-detail');
  const actions = document.querySelector('.room-deck-layout .room-actions');
  const cols = layout ? getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
  const detailText = detail ? detail.textContent : '';
  const skillCount = detail ? detail.querySelectorAll('.detail-skill').length : 0;
  const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
  const pickerRight = picker ? Math.round(picker.getBoundingClientRect().right) : 0;
  const detailLeft = detail ? Math.round(detail.getBoundingClientRect().left) : 0;
  return {
    hasLayout: Boolean(layout), cols, skillCount,
    // ⚠️ 别在 evaluate 的模板字符串里写正则简写（如 \d）：模板字符串会把未知转义的反斜杠
    // 吃掉（'\d' → 'd'），正则永远匹配不上。这里改用子串判断。
    hasSkills: detailText.includes('消耗') && detailText.includes('冷却'),
    hasTip: detailText.includes('技能消耗场上被我方棋子占用的魔力植物'),
    // bugv34l：左栏 = 角色选择器 + 底部按钮；右栏 = 技能详情
    actionsInMain: Boolean(main && actions && main.contains(actions)),
    pickerAboveActions: top(picker) !== null && top(actions) !== null && top(picker) < top(actions),
    detailOnRight: detailLeft >= pickerRight - 2,
  };
`)
check(
  '#27 房间「我的角色」= 左栏[角色选择器 + 底部按钮] + 右栏技能详情（与单机同款：技能名/消耗/冷却/说明）',
  deckUi && deckUi.hasLayout && deckUi.cols === 2 && deckUi.skillCount >= 2 && deckUi.hasSkills && deckUi.hasTip &&
    deckUi.actionsInMain && deckUi.pickerAboveActions && deckUi.detailOnRight,
  deckUi,
)


// --- #28 设置 → 黑夜：拆成两个独立开关（bugv34m） ------------------------------
const nightSwitch = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = true;
  await new Promise((r) => setTimeout(r, 420));
  const btn = [...document.querySelectorAll('.settings-nav__item')].find((el) => el.textContent.includes('黑夜'));
  if (!btn) return { hasTab: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 320));
  const pane = document.querySelector('.settings-pane');
  const rows = [...pane.querySelectorAll('.toggle-row')];
  const labels = rows.map((el) => (el.querySelector('.toggle-row__title')?.textContent ?? '').trim());
  const isSwitch = rows.map((el) => Boolean(el.getAttribute('role') === 'switch' && el.querySelector('.toggle-switch')));
  // 先手动摆成 (黑夜关 / 黑夜开局开)，看两个开关的视觉状态是否各归各的
  g.ui.nightConfig.enabled = false;
  g.ui.nightConfig.startInNight = true;
  await new Promise((r) => setTimeout(r, 300));
  const onStates = rows.map((el) => Boolean(el.querySelector('.toggle-switch')?.classList.contains('is-on')));
  // 各点一次：两个开关应当各自翻转（互不影响）
  rows.forEach((el) => el.click());
  await new Promise((r) => setTimeout(r, 300));
  return {
    hasTab: true,
    count: rows.length,
    labels,
    isSwitch,
    onStates,
    after: { enabled: g.ui.nightConfig.enabled, startInNight: g.ui.nightConfig.startInNight },
  };
`)
check(
  '#28 设置 → 黑夜：拆成两个独立开关（黑夜 / 黑夜开局），互不影响',
  nightSwitch &&
    nightSwitch.hasTab &&
    nightSwitch.count === 2 &&
    nightSwitch.labels.includes('黑夜') &&
    nightSwitch.labels.includes('黑夜开局') &&
    nightSwitch.isSwitch.every(Boolean) &&
    nightSwitch.onStates[nightSwitch.labels.indexOf('黑夜')] === false &&
    nightSwitch.onStates[nightSwitch.labels.indexOf('黑夜开局')] === true &&
    nightSwitch.after.enabled === true &&
    nightSwitch.after.startInNight === false,
  nightSwitch,
)

// --- #29 游戏规则补充黑夜章节（进入 / 退出条件 + 7 种天气） ---------------------
const rulesNight = await ev(`
  const g = window.__CONNECT4__;
  g.ui.showSettings = false;
  // 前面几步把界面切到了联机房间，先回到主菜单，才能点到「游戏规则」
  g.ui.screen = 'menu';
  g.ui.mode = 'pve';
  await new Promise((r) => setTimeout(r, 360));
  const btn = [...document.querySelectorAll('.start-menu__actions .menu-btn')].find(
    (b) => (b.querySelector('.menu-btn__label')?.textContent ?? '').includes('游戏规则'),
  );
  btn?.click();
  await new Promise((r) => setTimeout(r, 340));
  const body = document.querySelector('.rules-modal__body')?.textContent ?? '';
  const out = {
    open: Boolean(document.querySelector('.rules-modal')),
    items: document.querySelectorAll('.rules-modal__item').length,
    hasEnter: body.includes('进入黑夜'),
    hasExit: body.includes('退出黑夜'),
    weathers: ['雷暴', '干涸', '枯竭', '瘟疫', '旱雷', '暴雪', '极光'].filter((w) => body.includes(w)),
    hasDefaults: body.includes('20 回合') && body.includes('50 回合') && body.includes('30 回合'),
  };
  document.querySelector('.rules-modal .primary-btn')?.click();
  return out;
`)
check(
  '#29 游戏规则补充黑夜：进入 / 退出条件（含默认数值）+ 7 种天气全覆盖',
  rulesNight &&
    rulesNight.open &&
    rulesNight.items >= 20 &&
    rulesNight.hasEnter &&
    rulesNight.hasExit &&
    rulesNight.hasDefaults &&
    rulesNight.weathers.length === 7,
  rulesNight,
)

// --- #30 新增角色 Qwen（特征色 #284deb + 立绘 + 两个技能） ---------------------
const qwen = await ev(`
  const g = window.__CONNECT4__;
  g.ui.screen = 'menu';
  g.ui.showSettings = false;
  await new Promise((r) => setTimeout(r, 340));
  g.setCharacter(0, 'qwen');
  await new Promise((r) => setTimeout(r, 340));
  const picker = document.querySelector('.character-picker');
  const detail = document.querySelector('.character-detail');
  const detailText = detail?.textContent ?? '';
  return {
    character: g.players[0].character,
    hasQwenCard: (picker?.textContent ?? '').includes('Qwen'),
    color: detail ? getComputedStyle(detail).getPropertyValue('--char-color').trim() : '',
    hasSkill1: detailText.includes('本地部署'),
    hasSkill2: detailText.includes('小千问'),
    art: g.players[0].art?.idle ?? '',
  };
`)
check(
  '#30 新增角色 Qwen：轮播可选、特征色 #284deb、立绘 + 两个技能详情齐全',
  qwen &&
    qwen.character === 'qwen' &&
    qwen.color.toLowerCase() === '#284deb' &&
    qwen.hasQwenCard &&
    qwen.hasSkill1 &&
    qwen.hasSkill2 &&
    String(qwen.art).length > 0,
  qwen,
)

const failed = results.filter((r) => !r.ok)
console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
await close?.()
await server.close?.()
process.exit(failed.length === 0 ? 0 : 1)
