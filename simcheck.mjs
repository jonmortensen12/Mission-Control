// node simcheck.mjs - the simulation, headless, with the computer crew at
// every station. Fast: a couple of seconds.
//
// What it holds the game to:
//   - a run is its seed: the same seed and inputs give the same flight
//   - a fresh ship with a computer crew reaches space and then dies
//     somewhere sensible (not in the first sector, not never)
//   - upgrades are worth buying: a maxed ship goes clearly further
//   - nobody steering and nobody on the throttle falls back to Earth
//   - the shield blocks from the side it faces and only that side
//   - the power split never spends more than the reactor has
//   - seats go to people in priority order and the computer gets the rest
import {createRequire} from 'module';
const require = createRequire(import.meta.url);
const MC = require('./web/sim.js');

let fails = 0;
function ok(cond, msg){ console.log((cond ? '  ok   ' : '  FAIL ') + msg); if(!cond) fails++; }

const ALL = {pilot: 1, gunner: 1, shields: 1, thrusters: 1};
function fly(seed, lv, auto = ALL, limit = 1800){
  const S = MC.newRun(seed, lv);
  let pipBad = false;
  while(S.phase === 'flight' && S.t < limit){
    const inp = {};
    MC.ai(S, auto, inp, 1 / 60).forEach(a => MC.act(S, a));
    MC.step(S, inp, 1 / 60);
    if(S.pips.s + S.pips.w + S.pips.e > S.st.pipMax) pipBad = true;
  }
  return {S, pipBad};
}
const lvAll = n => ({hull: n, eng: n, laser: n, shield: n, reactor: n});

console.log('determinism');
{
  const a = fly(4242, lvAll(1)).S, b = fly(4242, lvAll(1)).S;
  ok(a.maxAlt === b.maxAlt && a.t === b.t && a.cause === b.cause, 'same seed, same flight (' + Math.round(a.maxAlt) + ' km both times)');
}

console.log('a fresh ship, computer crew');
const fresh = [];
let pipBad = false;
for(let i = 1; i <= 10; i++){ const r = fly(i * 7919, lvAll(0)); fresh.push(r.S); pipBad = pipBad || r.pipBad; }
const kms = fresh.map(S => S.maxAlt), mean = kms.reduce((a, b) => a + b) / kms.length;
ok(fresh.every(S => S.maxAlt > MC.SPACE_KM), 'every run reaches space');
ok(fresh.every(S => S.phase === 'dead'), 'every run ends');
ok(mean > 450 && mean < 1600, 'mean distance ' + Math.round(mean) + ' km (wants 450-1600)');
const meanT = fresh.reduce((a, S) => a + S.t, 0) / fresh.length;
ok(meanT > 90 && meanT < 420, 'mean run ' + Math.round(meanT) + ' s (wants 1.5-7 minutes)');
ok(!pipBad, 'the power split never exceeds the reactor');
const cr = fresh.map(MC.credits), meanCr = cr.reduce((a, b) => a + b) / cr.length;
ok(meanCr >= MC.COSTS[0] && meanCr < MC.COSTS[0] * 4, 'a run earns ' + Math.round(meanCr) + ' credits: at least one upgrade, not the shop');

console.log('upgrades');
{
  let far = 0;
  for(let i = 1; i <= 10; i++) far += fly(i * 7919, lvAll(5)).S.maxAlt;
  far /= 10;
  ok(far > mean * 1.4, 'a maxed ship goes ' + Math.round(far) + ' km vs ' + Math.round(mean) + ' km fresh');
}

console.log('nobody at the controls');
{
  // a thrusters officer who pulls the throttle right back
  const S = MC.newRun(99, lvAll(0));
  while(S.phase === 'flight' && S.t < 120){
    const inp = {thr: S.t < 8 ? 0.8 : 0.05};
    MC.ai(S, {pilot: 1, gunner: 1, shields: 1}, inp, 1 / 60).forEach(a => MC.act(S, a));
    MC.step(S, inp, 1 / 60);
  }
  ok(S.phase === 'dead' && /Earth/.test(S.cause), 'throttle off in the atmosphere falls back to Earth (' + S.cause + ')');
}

console.log('the atmosphere');
{
  const fresh = MC.newRun(3, lvAll(0));
  let tSpace = null;
  while(fresh.phase === 'flight' && fresh.alt < MC.SPACE_KM && fresh.t < 300){
    const inp = {}; MC.ai(fresh, ALL, inp, 1 / 60).forEach(a => MC.act(fresh, a)); MC.step(fresh, inp, 1 / 60);
  }
  tSpace = fresh.t;
  ok(fresh.phase === 'flight' && tSpace > 55 && tSpace < 110, 'a fresh ship takes ' + Math.round(tSpace) + ' s to reach space (wants about a minute or more)');
  ok(fresh.staged, 'the computer drops the booster on the way');

  // never staging: half thrust from 45 km
  const a = MC.newRun(4, lvAll(0)), b = MC.newRun(4, lvAll(0));
  [a, b].forEach(S => { S.alt = 46; S.v = 120; S.lifted = true; });
  MC.step(a, {thr: 0.74}, 1 / 60); MC.step(b, {thr: 0.74}, 1 / 60);
  ok(a.stageDue && b.stageDue, 'passing 45 km asks for staging');
  MC.act(b, {t: 'stage'});
  for(let i = 0; i < 600; i++){ MC.step(a, {thr: 0.74}, 1 / 60); MC.step(b, {thr: 0.74}, 1 / 60); }
  ok(b.staged && b.alt > a.alt + 3, 'a dropped booster climbs faster (' + Math.round(b.alt) + ' km vs ' + Math.round(a.alt) + ' km)');

  // a stall low down is a fall back to Earth
  const c = MC.newRun(5, lvAll(0));
  c.alt = 2; c.v = 60; c.lifted = true; c.stall = 3; c.heat = 70;
  for(let i = 0; i < 400 && c.phase === 'flight'; i++) MC.step(c, {thr: 0.74}, 1 / 60);
  ok(c.phase === 'dead' && /Earth/.test(c.cause), 'overheating at 2 km drops the ship back to Earth');

  // Max-Q
  const q = MC.newRun(6, lvAll(0));
  q.alt = 15; q.v = 330; q.lifted = true; q.staged = true;
  const h0 = q.hull;
  for(let i = 0; i < 60; i++){ q.objs.length = 0; MC.step(q, {thr: 1}, 1 / 60); }
  ok(q.hull < h0 - 4, 'too fast through Max-Q tears at the hull (' + Math.round(h0 - q.hull) + ' in a second)');
}

console.log('pilot and thrusters share the engines');
{
  const calm = MC.newRun(8, lvAll(0)), wild = MC.newRun(8, lvAll(0));
  [calm, wild].forEach(S => { S.alt = 300; S.v = 250; S.lifted = true; S.sector = {n: 1, at: 100, theme: 'drift', name: 'x'}; S.flareT = 1e9; });
  for(let i = 0; i < 600; i++){
    calm.objs.length = wild.objs.length = 0;
    MC.step(calm, {thr: 0.7, px: 0}, 1 / 60);
    MC.step(wild, {thr: 0.7, px: Math.floor(i / 30) % 2 ? 1 : -1}, 1 / 60);
  }
  ok(wild.fuel < calm.fuel - 5, 'swerving burns fuel (' + Math.round(calm.fuel - wild.fuel) + ' more in ten seconds)');
  ok(wild.heat > calm.heat + 20, 'and heats the engines the thrusters officer is minding');
}

console.log('events from between ticks');
{
  const S = MC.newRun(9, lvAll(0));
  MC.step(S, {}, 1 / 60);
  MC.act(S, {t: 'side', s: 'L'});
  MC.step(S, {}, 1 / 60);
  ok(S.events.some(e => e.type === 'side'), 'turning the shield between ticks still makes its sound');
}

console.log('shields');
{
  const S = MC.newRun(5, lvAll(0));
  S.side = 'F';
  const hull0 = S.hull, E0 = S.E;
  S.ebolts.push({x: S.x, y: MC.SHIP_Y - 20, vx: 0, vy: 400, dmg: 10, life: 1});
  MC.step(S, {}, 1 / 60);
  ok(S.hull === hull0 && S.E < E0, 'a shot from the front is blocked by the front shield');
  const h1 = S.hull;
  S.ebolts.push({x: S.x - 20, y: MC.SHIP_Y, vx: 400, vy: 0, dmg: 10, life: 1});
  MC.step(S, {}, 1 / 60);
  ok(S.hull < h1, 'a shot from the left gets through a front shield');
  S.side = 'L';
  const h2 = S.hull;
  S.ebolts.push({x: S.x - 20, y: MC.SHIP_Y, vx: 400, vy: 0, dmg: 10, life: 1});
  MC.step(S, {}, 1 / 60);
  ok(S.hull === h2, 'and is blocked once the shield is turned left');
}

console.log('the mothership');
{
  // fly a maxed ship until sector 3, where the first one waits
  const S = MC.newRun(31337, lvAll(5));
  let met = null, sectorWhileBoss = null, down = false;
  while(S.phase === 'flight' && S.t < 900){
    const inp = {};
    MC.ai(S, ALL, inp, 1 / 60).forEach(a => MC.act(S, a));
    MC.step(S, inp, 1 / 60);
    S.events.forEach(e => {
      if(e.type === 'boss' && met === null) met = S.sector.n;
      if(e.type === 'bossdown') down = true;
    });
    if(S.boss && sectorWhileBoss === null) sectorWhileBoss = S.sector.n;
    if(S.boss && S.alt - S.sector.at > MC.SECTOR_KM + 50 && S.sector.n !== sectorWhileBoss) sectorWhileBoss = -1;
    if(down) break;
  }
  ok(met === 3, 'the first mothership is sector 3 (met in ' + met + ')');
  ok(sectorWhileBoss === 3, 'the sector does not move on while it lives');
  ok(down && S.stats.bosses === 1 && S.stats.killCr >= 80, 'a maxed computer crew destroys it, for its bounty');
  // and it is worth meeting: every third sector
  const T = MC.newRun(7, lvAll(5));
  T.alt = 100 + MC.SECTOR_KM * 5 + 1; T.sector = {n: 5, at: 100 + MC.SECTOR_KM * 4, theme: 'belt', name: 'x'};
  MC.step(T, {}, 1 / 60);
  ok(T.sector.n === 6 && T.boss && T.sector.theme === 'boss', 'sector 6 is a mothership too');
}

console.log('solar flares');
{
  const S = MC.newRun(77, lvAll(0));
  S.alt = 300; S.v = 250; S.lifted = true; S.sector = {n: 1, at: 100, theme: 'drift', name: 'x'};
  S.flareT = 0.01;
  MC.step(S, {thr: 0.6}, 1 / 60);
  ok(S.flare && S.flare.warn > 2.9, 'a flare announces itself three seconds early');
  const side = S.flare.side;
  S.side = side; S.hull = 50;
  const h = S.hull;
  for(let i = 0; i < 60 * 6; i++){ S.objs.length = 0; S.ebolts.length = 0; S.E = S.st.Emax; MC.step(S, {thr: 0.6}, 1 / 60); }
  ok(S.hull === h && S.stats.flares === 1, 'facing it with the shield takes none of it');
  const T = MC.newRun(77, lvAll(0));
  T.alt = 300; T.v = 250; T.lifted = true; T.sector = {n: 1, at: 100, theme: 'drift', name: 'x'}; T.flareT = 0.01;
  MC.step(T, {thr: 0.6}, 1 / 60);
  T.side = MC.SIDES.find(x => x !== T.flare.side); T.hull = 50;
  for(let i = 0; i < 60 * 6; i++){ T.objs.length = 0; T.ebolts.length = 0; MC.step(T, {thr: 0.6}, 1 / 60); }
  ok(T.hull < 50 - 20, 'facing anywhere else burns the hull (' + Math.round(50 - T.hull) + ' damage)');
}

console.log('power');
{
  const S = MC.newRun(6, lvAll(0));
  for(let i = 0; i < 10; i++) MC.act(S, {t: 'pip', sys: 'e', d: 1});
  ok(S.pips.e === 5 && S.pips.s + S.pips.w + S.pips.e === S.st.pipMax, 'engines fill to 5, taken from the others');
  MC.act(S, {t: 'pips', s: 6, w: 6, e: 6});
  ok(S.pips.e === 5, 'an allocation over the reactor is refused');
}

console.log('seats');
{
  let c = MC.assign({}, ['a']);
  ok(c.pilot === 'a' && !c.shields && !c.gunner && !c.thrusters, 'one person flies; the computer runs the rest');
  c = MC.assign(c, ['a', 'b']);
  ok(c.pilot === 'a' && c.shields === 'b', 'the second person takes shields');
  c = MC.assign(c, ['a', 'b', 'c', 'd', 'e']);
  ok(c.gunner === 'c' && c.thrusters === 'd' && Object.values(c).indexOf('e') < 0, 'four seats; a fifth person waits');
  c = MC.assign({pilot: 'a', shields: 'b'}, ['b']);
  ok(c.shields === 'b' && c.pilot === null, 'somebody leaving does not move anybody else');
}

console.log('the shop');
{
  const save = {credits: 100, lv: MC.freshLevels()};
  ok(MC.buy(save, 'hull') && save.lv.hull === 1 && save.credits === 100 - MC.COSTS[0], 'buying spends the credits');
  ok(!MC.buy(save, 'hull'), 'cannot buy what you cannot afford');
  save.credits = 1e6; save.lv.eng = 5;
  ok(!MC.buy(save, 'eng'), 'cannot buy past the top level');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
