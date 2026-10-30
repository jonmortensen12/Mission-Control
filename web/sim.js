/* Mission Control - the simulation.

   Everything that decides what happens lives here, and nothing that draws
   or makes a sound. The TV page (index.html) steps it and paints it; the
   check scripts (simcheck.mjs) step it with no screen at all, which is how
   the difficulty is tuned without anybody having to sit through a run.

   Deterministic: a run is its seed plus the inputs it was given. The
   computer crew draws from its own generator (S.airng) so that a person
   taking over a station never changes where the asteroids are.

   Screen space, not world space. The ship sits at a fixed height on a
   1600x900 board and the universe scrolls past it at the ship's speed, so
   "speed" is pixels a second and an object's place is where it is on the
   television. 50 pixels of travel is one kilometre. */
(function(root){
'use strict';

var W = 1600, H = 900, SHIP_Y = 700, SHIP_R = 34;
var PX_PER_KM = 50;             // in space
var ATM_PX_PER_KM = 110;        // in the atmosphere: a longer climb than the numbers say
var SPACE_KM = 100;            // the Karman line: gravity off, sectors begin
var STAGE_KM = 45;             // where the booster runs dry and has to be dropped
var MAXQ = [10, 26];           // the band where going too fast tears at the hull
var MAXQ_V = 175;              // px/s: faster than this in the band does damage

/* How far up the screen an altitude is, counting from the pad. The
   atmosphere is drawn at more pixels to the kilometre than space, so the
   climb takes a minute and more without the ship crawling. */
function altPx(alt){
  return alt < SPACE_KM ? alt * ATM_PX_PER_KM : SPACE_KM * ATM_PX_PER_KM + (alt - SPACE_KM) * PX_PER_KM;
}
var SECTOR_KM = 400;
var STATIONS = ['pilot', 'shields', 'gunner', 'thrusters'];   // priority order
var SIDES = ['F', 'R', 'B', 'L'];

/* What the hangar sells. Five levels each; the cost of the NEXT level is
   COSTS[current level]. */
var UPGRADES = [
  {key:'hull',    name:'Hull',    station:'pilot',     blurb:'More armour before the ship comes apart'},
  {key:'eng',     name:'Engines', station:'thrusters', blurb:'More thrust, a bigger tank, runs cooler'},
  {key:'laser',   name:'Lasers',  station:'gunner',    blurb:'Harder hits, faster fire, twin cannons at 3'},
  {key:'shield',  name:'Shields', station:'shields',   blurb:'A bigger shield that recharges faster'},
  {key:'reactor', name:'Reactor', station:'shields',   blurb:'One more power pip to share out per level'}
];
var COSTS = [80, 180, 340, 560, 850];

/* Paint jobs, unlocked by how far the family has ever flown. Cosmetic -
   something to show for a record besides the number. */
var PAINTS = [
  {key: 'classic',  name: 'Classic',  km: 0,    body: ['#90a4ae', '#eceff1', '#78909c'], fin: '#c62828'},
  {key: 'midnight', name: 'Midnight', km: 500,  body: ['#1a237e', '#5c6bc0', '#0d1442'], fin: '#ffd54f'},
  {key: 'tiger',    name: 'Tiger',    km: 1000, body: ['#e65100', '#ffb74d', '#bf360c'], fin: '#fff8e1'},
  {key: 'mint',     name: 'Mint',     km: 1500, body: ['#00897b', '#a7ffeb', '#00695c'], fin: '#f06292'},
  {key: 'gold',     name: 'Gold',     km: 2500, body: ['#b8860b', '#fff176', '#8d6e00'], fin: '#6d4c41'},
  {key: 'ghost',    name: 'Ghost',    km: 4000, body: ['#cfd8dc', '#ffffff', '#b0bec5'], fin: '#7c4dff'}
];
var MAX_LV = 5;

function mulberry(seed){
  var a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function rr(r, a, b){ return a + (b - a) * r(); }
function pick(r, arr){ return arr[Math.floor(r() * arr.length)]; }

function freshLevels(){ return {hull:0, eng:0, laser:0, shield:0, reactor:0}; }

/* ---------- the ship's numbers, from its upgrade levels ---------- */
function stats(lv){
  return {
    hullMax: 100 + 40 * lv.hull,
    thrustMul: 1 + 0.15 * lv.eng,
    fuelMax: 100 + 30 * lv.eng,
    heatMul: 1 - 0.1 * lv.eng,
    dmg: 1 + 0.35 * lv.laser,
    fireGap: 1 / (5 + lv.laser),
    twin: lv.laser >= 3,
    Emax: 40 + 20 * lv.shield,
    regenMul: 1 + 0.25 * lv.shield,
    pipMax: 6 + lv.reactor
  };
}

function newRun(seed, lv){
  lv = lv || freshLevels();
  var st = stats(lv);
  var S = {
    seed: seed >>> 0, rng: mulberry(seed), airng: mulberry(seed ^ 0x9e3779b9),
    lv: lv, st: st,
    t: 0, phase: 'flight', cause: '',
    alt: 0, maxAlt: 0, v: 0, lifted: false,
    staged: false, stageDue: false,   // the booster: dropped yet, and is it time
    gust: 0, gustT: 3,                 // turbulence: the push now, and the next one
    stress: 0,                         // Max-Q: how hard the air is pulling at the hull, 0-1
    x: W / 2, vx: 0,
    hull: st.hullMax, E: st.Emax, side: 'F', sideCd: 0,
    pips: {s: 2, w: 2, e: 2},
    thr: 0.7, heat: 0, stall: 0, fuel: st.fuelMax, boostT: 0, boostCd: 0,
    gun: {a: 0, heat: 0, over: false, cd: 0},
    objs: [], bolts: [], ebolts: [],
    events: [], queued: [], inStep: false,
    spawn: {},
    sector: {n: 0, name: 'Launch Pad', theme: 'earth', at: 0},
    boss: null,            // the mothership, while there is one
    flare: null,           // {side, warn, burn} - a solar flare on its way or burning
    flareT: 40,            // seconds until the next one is due
    planet: null,
    zone: 'ground',
    stats: {kills: 0, blocked: 0, pickups: 0, boosts: 0, gems: 0, hits: 0, killCr: 0, stages: 0, steer: 0,
            bosses: 0, flares: 0, planets: []},
    ai: {pilot: {t: 0, px: 0}, gunner: {t: 0, target: null, a: 0}, shields: {t: 0, flareSeen: 0}},
    nextId: 1
  };
  // spare reactor pips start in the shields
  S.pips.s += st.pipMax - 6;
  return S;
}

/* Events are what the TV turns into sound and sparks. Ones raised by an
   action between ticks (a shield turned, a boost, staging) wait in
   S.queued and come out with the next tick's, rather than being wiped by
   it - which is what used to happen, so those never made a sound. */
function emit(S, type, o){ o = o || {}; o.type = type; (S.inStep ? S.events : S.queued).push(o); }

/* ---------- actions: the discrete things a station does ---------- */
function act(S, a){
  if(S.phase !== 'flight') return;
  if(a.t === 'side'){
    if(SIDES.indexOf(a.s) >= 0 && a.s !== S.side){ S.side = a.s; emit(S, 'side', {s: a.s}); }
  } else if(a.t === 'boost'){
    if(S.boostCd <= 0 && S.stall <= 0 && S.fuel > 6){
      S.boostT = 1.2; S.boostCd = 4; S.fuel -= 6; S.heat += 18;
      S.stats.boosts++;
      emit(S, 'boost');
    }
  } else if(a.t === 'stage'){
    if(S.stageDue && !S.staged){
      S.staged = true; S.stageDue = false; S.stats.stages = 1;
      emit(S, 'staged', {x: S.x});
    }
  } else if(a.t === 'pip'){
    pip(S, a.sys, a.d);
  } else if(a.t === 'pips'){
    // a whole allocation at once (the computer's shields officer)
    var tot = a.s + a.w + a.e;
    if(tot <= S.st.pipMax && a.s >= 0 && a.w >= 0 && a.e >= 0 && a.s <= 5 && a.w <= 5 && a.e <= 5)
      S.pips = {s: a.s, w: a.w, e: a.e};
  }
}

/* One more pip in a system. When the reactor is fully spent the pip is
   taken from whichever other system has most, so a tap always does what it
   says rather than silently doing nothing. */
function pip(S, sys, d){
  if(!(sys in S.pips)) return;
  var p = S.pips;
  if(d < 0){ if(p[sys] > 0) p[sys]--; return; }
  if(p[sys] >= 5) return;
  var tot = p.s + p.w + p.e;
  if(tot >= S.st.pipMax){
    var from = null;
    ['s', 'w', 'e'].forEach(function(k){
      if(k !== sys && p[k] > 0 && (from === null || p[k] > p[from])) from = k;
    });
    if(from === null) return;
    p[from]--;
  }
  p[sys]++;
}

/* ---------- difficulty and sectors ---------- */
function difficulty(S){ return Math.max(0, S.alt - SPACE_KM) / 600; }

var THEMES = {
  orbit:  {ast: 0.8, ali: 0.5, pick: 1.2, words: ['Low Orbit']},
  belt:   {ast: 2.2, ali: 0.5, pick: 1.0, words: ['Belt', 'Shoals', 'Rubble Field', 'Scree']},
  patrol: {ast: 0.6, ali: 2.0, pick: 1.0, words: ['Patrol Lane', 'Picket', 'Watch']},
  flyby:  {ast: 0.8, ali: 0.8, pick: 1.6, words: ['Flyby']},
  storm:  {ast: 1.1, ali: 1.0, pick: 1.0, words: ['Ion Storm', 'Maelstrom', 'Static'], regen: 0.35},
  drift:  {ast: 0.45, ali: 0.4, pick: 2.0, words: ['Quiet', 'Reach', 'Expanse']},
  nest:   {ast: 1.2, ali: 2.6, pick: 1.0, words: ['Hive', 'Nest', 'Swarm'], minD: 2.5},
  // every third sector: a mothership, and little else while it lives
  boss:   {ast: 0.3, ali: 0, pick: 1.4, words: ['Mothership']}
};
var NAMES = ['Kepler', 'Vega', 'Orion', 'Halcyon', 'Tycho', 'Nyx', 'Cobalt', 'Juno',
             'Sable', 'Ember', 'Hollow', 'Iris', 'Rook', 'Zephyr', 'Marrow', 'Lumen',
             'Corvid', 'Thistle', 'Ash', 'Brine', 'Quill', 'Vesper', 'Aster', 'Oberon'];
var PLANET_COLS = [['#d9784a', '#7a2f17'], ['#5fa3d9', '#1b3b66'], ['#a7d96b', '#365c1c'],
                   ['#d9c36b', '#6b5222'], ['#b07ad9', '#43215f'], ['#e0e0e0', '#5a5a66']];

function planetName(r){
  var a = ['Ka', 'Zu', 'Mir', 'Tal', 'Vo', 'Ree', 'Sol', 'Ix', 'Pra', 'Ul', 'Nem', 'Dor'];
  var b = ['ros', 'ani', 'tek', 'vos', 'lune', 'mar', 'dia', 'gon', 'bis', 'thea'];
  return pick(r, a) + pick(r, b) + (r() < 0.3 ? ' ' + pick(r, ['II', 'IV', 'Prime', 'b', 'VII']) : '');
}

function newSector(S){
  var r = S.rng, n = S.sector.n + 1, theme, name;
  if(n === 1){ theme = 'orbit'; name = 'Low Orbit'; }
  else if(n % 3 === 0){
    theme = 'boss';
    var bn = pick(r, NAMES);
    name = 'The ' + bn + ' Mothership';
    spawnBoss(S, bn);
  } else {
    var d = difficulty(S), pool = ['belt', 'patrol', 'flyby', 'storm', 'drift'];
    if(d >= THEMES.nest.minD) pool.push('nest', 'nest');
    // a breather after a hard one, and never the same twice running
    if(n === 2) pool = ['belt', 'patrol', 'flyby'];
    do { theme = pick(r, pool); } while(theme === S.sector.theme);
    if(theme === 'flyby'){
      var pn = planetName(r), cols = pick(r, PLANET_COLS);
      S.planet = {name: pn, x: r() < 0.5 ? rr(r, 150, 420) : rr(r, 1180, 1450),
                  y: -420, r: rr(r, 220, 330), c1: cols[0], c2: cols[1], ring: r() < 0.5};
      name = 'Flyby of ' + pn;
      S.stats.planets.push(pn);
    } else {
      name = pick(r, NAMES) + ' ' + pick(r, THEMES[theme].words);
    }
  }
  S.sector = {n: n, name: name, theme: theme, at: S.alt};
  emit(S, 'sector', {n: n, name: name, theme: theme});
}

function zoneOf(alt){
  if(alt < 1) return 'ground';
  if(alt < 12) return 'troposphere';
  if(alt < 50) return 'stratosphere';
  if(alt < SPACE_KM) return 'mesosphere';
  return 'space';
}
var ZONE_NAMES = {troposphere: 'Clouds', stratosphere: 'Stratosphere',
                  mesosphere: 'Mesosphere', space: 'SPACE!'};

/* ---------- making things ---------- */
function spawnObj(S, o){
  o.id = S.nextId++;
  if(o.hp == null) o.hp = 1;
  o.maxHp = o.hp;
  if(o.ride == null) o.ride = 1;
  if(o.vx == null) o.vx = 0;
  if(o.vy == null) o.vy = 0;
  o.t = 0;
  S.objs.push(o);
  return o;
}

function asteroid(S, x, y, r, vx, vy, d){
  var rng = S.rng, n = 9, shape = [];
  for(var i = 0; i < n; i++) shape.push(rr(rng, 0.72, 1.08));
  return spawnObj(S, {kind: 'rock', x: x, y: y, r: r, vx: vx, vy: vy,
    hp: Math.ceil(r / 9 * (1 + 0.25 * d)), dmg: Math.round(4 + r * 0.35),
    spin: rr(rng, -1.5, 1.5), rot: rr(rng, 0, 6.28), shape: shape, hostile: true, cr: 1});
}

/* The mothership. Parks across the top of the screen, sweeps side to side,
   fires fans of shots, launches scouts and sends slow homing torpedoes the
   gunner has to shoot down. While it lives the sector does not end; if it
   is not destroyed in seventy seconds it leaves. */
function spawnBoss(S, name){
  var d = difficulty(S);
  S.boss = spawnObj(S, {kind: 'mother', name: name, x: W / 2, y: -160, r: 92, ride: 0,
    hp: Math.round(300 * (1 + 0.45 * d)), dmg: 45, hostile: true, alien: true, cr: 80,
    volley: 3, launch: 5, torp: 7, leave: 70, boss: true});
  emit(S, 'boss', {name: name});
}

/* A solar flare: three seconds of warning from one side, then a burn from
   that side. The shield facing it takes it; anything else and the hull
   does. It is the shields officer's moment, and the warning is for the
   rest of the crew to shout. */
function flareTick(S, dt){
  var r = S.rng, d = difficulty(S);
  if(!S.flare){
    if(S.alt < SPACE_KM + 30 || S.boss) return;
    S.flareT -= dt;
    if(S.flareT > 0) return;
    S.flareT = rr(r, 35, 60) / (1 + 0.15 * d);
    S.flare = {side: pick(r, SIDES), warn: 3, burn: 2.4, tick: 0};
    emit(S, 'flarewarn', {side: S.flare.side});
    return;
  }
  var f = S.flare;
  if(f.warn > 0){
    f.warn -= dt;
    if(f.warn <= 0){ emit(S, 'flare', {side: f.side}); S.stats.flares++; }
    return;
  }
  f.burn -= dt; f.tick -= dt;
  if(f.tick <= 0){
    f.tick = 0.25;
    var at = {F: [S.x, SHIP_Y - 200], B: [S.x, SHIP_Y + 200], L: [S.x - 200, SHIP_Y], R: [S.x + 200, SHIP_Y]}[f.side];
    hurt(S, 3.5 * (1 + 0.2 * d), {x: at[0], y: at[1]}, 'a solar flare');
  }
  if(f.burn <= 0) S.flare = null;
}

function spawnTick(S, dt){
  var r = S.rng, alt = S.alt, d = difficulty(S);
  var th = THEMES[S.sector.theme] || {ast: 1, ali: 1, pick: 1};
  function every(key, rate){
    if(rate <= 0) return false;
    if(S.spawn[key] == null) S.spawn[key] = rr(r, 0.3, 1.2) / rate;
    S.spawn[key] -= dt;
    if(S.spawn[key] <= 0){ S.spawn[key] = rr(r, 0.6, 1.4) / rate; return true; }
    return false;
  }
  if(alt < SPACE_KM){
    if(!S.lifted) return;
    // thunderclouds: not solid, but they throw lightning at anything close
    if(alt > 3 && alt < 20 && every('storm', 0.4))
      spawnObj(S, {kind: 'storm', x: rr(r, 120, 1480), y: -120, r: 90, vx: rr(r, -30, 30),
                   hostile: false, avoid: true, zapT: rr(r, 0.5, 1.2)});
    // geese, in a V, which is a wall to fly round or a lot of shooting
    if(alt < 16 && every('bird', 0.55)){
      var n = 3 + Math.floor(r() * 5), bx = rr(r, 150, 1450), bvx = rr(r, -90, 90);
      for(var bi = 0; bi < n; bi++){
        var side = bi % 2 ? 1 : -1, rank = Math.ceil(bi / 2);
        spawnObj(S, {kind: 'bird', x: bx + side * rank * 38, y: -40 - rank * 30, r: 16, vx: bvx, vy: 0,
                     hp: 1, dmg: 6, hostile: true, cr: 1, flap: rr(r, 0, 6)});
      }
    }
    if(alt > 8 && alt < 55 && every('plane', 0.6)){
      var fromL = r() < 0.5;
      spawnObj(S, {kind: 'plane', x: fromL ? -60 : 1660, y: rr(r, 60, 420), r: 28,
                   vx: fromL ? rr(r, 160, 260) : -rr(r, 160, 260), vy: 0, ride: 0.5,
                   hp: 3, dmg: 14, hostile: true, cr: 2});
    }
    if(alt > 25 && alt < 90 && every('balloon', 0.5))
      spawnObj(S, {kind: 'balloon', x: rr(r, 80, 1520), y: -50, r: 22, vx: rr(r, -20, 20),
                   hp: 1, dmg: 8, hostile: true, cr: 1});
    if(alt > 60 && every('junk', 0.7))
      asteroid(S, rr(r, 80, 1520), -50, rr(r, 14, 24), rr(r, -40, 40), rr(r, 0, 50), 0).kind = 'junk';
    if(alt > 20 && every('fuel', 0.05))
      spawnObj(S, {kind: 'fuel', x: rr(r, 120, 1480), y: -40, r: 20, hostile: false});
    return;
  }

  // ---- space ----
  var bigR = 40 + 10 * Math.min(d, 4);
  if(every('rock', (0.55 + 0.55 * d) * th.ast)){
    if(d > 0.5 && r() < 0.22){
      // in from the side, across the ship's path
      var L = r() < 0.5, rad = rr(r, 18, bigR);
      asteroid(S, L ? -rad - 10 : W + rad + 10, rr(r, 80, 480), rad,
               (L ? 1 : -1) * rr(r, 130, 220), rr(r, -30, 30), d);
    } else {
      asteroid(S, rr(r, 60, 1540), -80, rr(r, 18, bigR), rr(r, -60, 60), rr(r, -20, 80), d);
    }
  }
  if(alt > 120 && every('scout', (0.14 + 0.14 * d) * th.ali))
    spawnObj(S, {kind: 'scout', x: rr(r, 120, 1480), y: -40, r: 24, vx: 0, vy: 0, ride: 0,
                 hp: Math.ceil(3 * (1 + 0.3 * d)), dmg: 12, hostile: true, alien: true, cr: 5,
                 fire: rr(r, 1.2, 2.4), base: 0, ph: rr(r, 0, 6)});
  if(d > 0.8 && every('gunship', (0.04 + 0.04 * d) * th.ali))
    spawnObj(S, {kind: 'gunship', x: rr(r, 250, 1350), y: -60, r: 44, vx: 0, vy: 0, ride: 0,
                 hp: Math.ceil(12 * (1 + 0.3 * d)), dmg: 25, hostile: true, alien: true, cr: 15,
                 fire: 2, burst: 0, hold: rr(r, 6, 10)});
  if(d > 1.3 && every('rammer', (0.06 + 0.05 * d) * th.ali)){
    var side = r();
    spawnObj(S, {kind: 'rammer', x: side < 0.33 ? -40 : side < 0.66 ? W + 40 : rr(r, 200, 1400),
                 y: side < 0.66 ? rr(r, 150, 450) : -40, r: 20, ride: 0,
                 hp: Math.ceil(3 * (1 + 0.3 * d)), dmg: 18, hostile: true, alien: true, cr: 6,
                 lock: 0.9});
  }
  if(d > 1.9 && every('chaser', (0.04 + 0.035 * d) * th.ali))
    spawnObj(S, {kind: 'chaser', x: clamp(S.x + rr(r, -300, 300), 80, 1520), y: H + 40, r: 22,
                 vx: 0, vy: 0, ride: 0, hp: Math.ceil(4 * (1 + 0.3 * d)), dmg: 16,
                 hostile: true, alien: true, cr: 8});
  if(every('fuel', 0.07 * th.pick))
    spawnObj(S, {kind: 'fuel', x: rr(r, 120, 1480), y: -40, r: 20, hostile: false});
  if(every('repair', 0.035 * th.pick))
    spawnObj(S, {kind: 'repair', x: rr(r, 120, 1480), y: -40, r: 20, hostile: false});
  if(every('battery', 0.03 * th.pick))
    spawnObj(S, {kind: 'battery', x: rr(r, 120, 1480), y: -40, r: 18, hostile: false});
  if(every('gem', 0.05 * th.pick))
    spawnObj(S, {kind: 'gem', x: rr(r, 120, 1480), y: -40, r: 16, hostile: false});
}

/* ---------- damage: which side it came from, and the shield ---------- */
function sideOf(S, ox, oy){
  var dx = ox - S.x, dy = oy - SHIP_Y;
  if(Math.abs(dy) * 0.8 >= Math.abs(dx)) return dy < 0 ? 'F' : 'B';
  return dx > 0 ? 'R' : 'L';
}

function hurt(S, dmg, from, what){
  var side = sideOf(S, from.x, from.y);
  var blocked = 0;
  if(side === S.side && S.E > 0){
    blocked = Math.min(S.E, dmg);
    S.E -= blocked;
    S.stats.blocked += blocked;
  }
  var left = dmg - blocked;
  if(left > 0){
    S.hull -= left;
    S.stats.hits++;
  }
  emit(S, left > 0 ? 'hit' : 'block', {side: side, dmg: left, blocked: blocked, x: from.x, y: from.y});
  if(S.hull <= 0 && S.phase === 'flight'){
    S.hull = 0;
    var NICE = {bolt: 'Shot down', rock: 'Hit by an asteroid', junk: 'Hit by space junk',
                mother: 'Rammed the mothership', torpedo: 'Hit by a torpedo', bird: 'Hit a bird',
                lightning: 'Struck by lightning',
                plane: 'Hit a plane', balloon: 'Hit a weather balloon'};
    die(S, NICE[what] || (/^a /.test(what) ? 'Burned by ' + what : what ? 'Destroyed by a ' + what : 'Destroyed'));
  }
}

function die(S, cause){
  S.phase = 'dead';
  S.cause = cause;
  emit(S, 'dead', {cause: cause, x: S.x});
}

function kill(S, o){
  o.dead = true;
  if(o.boss){
    S.boss = null;
    S.stats.bosses++;
    emit(S, 'bossdown', {x: o.x, y: o.y, name: o.name});
  }
  S.stats.kills++;
  S.stats.killCr += o.cr || 0;
  emit(S, 'boom', {x: o.x, y: o.y, r: o.r, kind: o.kind});
  if((o.kind === 'rock') && o.r > 34){
    for(var i = 0; i < 2; i++){
      var k = asteroid(S, o.x, o.y, o.r * 0.58, o.vx + (i ? 1 : -1) * rr(S.rng, 60, 120),
                       o.vy + rr(S.rng, -40, 20), difficulty(S));
      k.rot = o.rot;
    }
  }
}

/* ---------- one tick ----------
   inp: {px:-1..1 pilot stick, thr:0..1 throttle, ga: turret angle (0 is up,
   clockwise), gf: turret firing}. Discrete things go through act(). */
function step(S, inp, dt){
  S.events = S.queued;
  S.queued = [];
  if(S.phase !== 'flight') return;
  S.inStep = true;
  try { stepTick(S, inp, dt); } finally { S.inStep = false; }
}

function stepTick(S, inp, dt){
  var st = S.st, r = S.rng;
  S.t += dt;

  // ----- engines -----
  var thr = clamp(inp.thr == null ? S.thr : inp.thr, 0, 1);
  S.thr = thr;
  var engF = 0.55 + 0.15 * S.pips.e, agility = 0.6 + 0.15 * S.pips.e;
  var fuelOK = S.fuel > 0 ? 1 : 0.35;
  // a spent booster still strapped on: half thrust until somebody drops it
  var boosterOK = S.stageDue && !S.staged ? 0.5 : 1;
  var thrust = S.stall > 0 ? 0 : 420 * st.thrustMul * engF * thr * fuelOK * boosterOK;
  if(S.boostT > 0){ thrust += 520; S.boostT -= dt; }
  if(S.boostCd > 0) S.boostCd -= dt;
  /* Gravity is strong low down: at the pad the engines need more than 45%
     just to hover, and a stall below a few kilometres is a fall back to
     Earth. It fades to nothing at the Karman line. */
  var atm = S.alt < SPACE_KM;
  var g = atm ? 40 + 120 * (1 - S.alt / SPACE_KM) : 0;
  var a = thrust - g - 1.0 * S.v;
  S.v += a * dt;
  S.alt += S.v * dt / (atm ? ATM_PX_PER_KM : PX_PER_KM);
  if(!S.staged && !S.stageDue && S.alt >= STAGE_KM){ S.stageDue = true; emit(S, 'stagedue'); }
  // Max-Q: too fast through the thick air and the hull feels it
  var inQ = S.alt > MAXQ[0] && S.alt < MAXQ[1];
  var over = inQ ? Math.max(0, S.v - MAXQ_V) : 0;
  var was = S.stress;
  S.stress = Math.min(1, over / 120);
  if(over > 0){
    S.hull -= over * 0.06 * dt;
    if(was === 0) emit(S, 'maxq');
    if(S.hull <= 0 && S.phase === 'flight'){ S.hull = 0; die(S, 'Torn apart at Max-Q - too fast in the thick air'); return; }
  }
  if(S.alt > 0.6) S.lifted = true;
  if(S.alt <= 0){
    S.alt = 0;
    if(S.lifted && S.v < 0){ die(S, 'Fell back to Earth - not enough thrust'); return; }
    if(S.v < 0) S.v = 0;
  }
  if(S.alt > S.maxAlt) S.maxAlt = S.alt;

  if(S.stall > 0){
    S.stall -= dt;
    if(S.stall <= 0) emit(S, 'restart');
  }
  if(thr > 0.75) S.heat += (thr - 0.75) * 80 * st.heatMul * dt;
  else S.heat -= (14 + (0.75 - thr) * 20) * dt;
  // climbing through thick air, the engines run hotter
  if(atm && thr > 0.6) S.heat += (thr - 0.6) * 18 * (1 - S.alt / SPACE_KM) * st.heatMul * dt;
  if(S.heat < 0) S.heat = 0;
  if(S.heat >= 100 && S.stall <= 0){
    S.stall = 3; S.heat = 70;
    emit(S, 'stall');
  }
  if(S.fuel > 0){
    S.fuel -= thr * 0.7 * dt;
    if(S.fuel <= 0){ S.fuel = 0; emit(S, 'nofuel'); }
  }

  // ----- steering -----
  /* The side thrusters run off the same tanks and the same engines as the
     main burn: every swerve costs fuel and heat. A pilot throwing the ship
     about makes the thrusters officer's job harder, and a hot engine is a
     reason for the pilot to fly smoother. */
  var target = clamp(inp.px || 0, -1, 1) * 560 * agility;
  var maxDv = 2400 * agility * dt;
  var dv = clamp(target - S.vx, -maxDv, maxDv);
  if(S.stall > 0) dv *= 0.35;                 // no engines, no side thrust to speak of
  if(S.fuel <= 0) dv *= 0.5;
  S.vx += dv;
  var steerCost = Math.abs(dv);
  S.heat += steerCost * 0.011 * st.heatMul;
  if(S.fuel > 0) S.fuel = Math.max(0, S.fuel - steerCost * 0.0035);
  S.stats.steer = (S.stats.steer || 0) + steerCost;
  // turbulence in the low sky: gusts that shove the ship sideways, and the
  // jet stream, a steady push between 8 and 14 km
  if(atm && S.lifted){
    S.gustT -= dt;
    if(S.gustT <= 0){
      S.gustT = rr(r, 1.5, 4);
      var strength = S.alt < 60 ? 1 : (SPACE_KM - S.alt) / 40;
      S.gust = (r() < 0.5 ? -1 : 1) * rr(r, 140, 300) * strength;
      emit(S, 'gust', {dir: S.gust > 0 ? 1 : -1});
    }
    S.vx += S.gust * dt;
    S.gust *= 1 - 1.6 * dt;
    if(S.alt > 8 && S.alt < 14) S.vx += 110 * dt;
  } else S.gust = 0;
  if(S.planet && S.sector.theme === 'flyby')
    S.vx += (S.planet.x < S.x ? -1 : 1) * 70 * dt;
  S.x += S.vx * dt;
  if(S.x < 60){ S.x = 60; S.vx = Math.max(0, S.vx); }
  if(S.x > W - 60){ S.x = W - 60; S.vx = Math.min(0, S.vx); }

  // ----- shields -----
  var th = THEMES[S.sector.theme] || {};
  S.E = Math.min(st.Emax, S.E + 2.6 * S.pips.s * st.regenMul * (th.regen || 1) * dt);

  // ----- turret -----
  var gun = S.gun;
  if(inp.ga != null && isFinite(inp.ga)) gun.a = inp.ga;
  var cool = 10 + 11 * S.pips.w;
  gun.heat = Math.max(0, gun.heat - cool * dt);
  if(gun.over && gun.heat < 40){ gun.over = false; emit(S, 'gunok'); }
  if(gun.cd > 0) gun.cd -= dt;
  if(inp.gf && !gun.over && S.pips.w > 0 && gun.cd <= 0){
    gun.cd = st.fireGap;
    var sx = Math.sin(gun.a), sy = -Math.cos(gun.a);
    var offs = st.twin ? [-9, 9] : [0];
    offs.forEach(function(o){
      S.bolts.push({x: S.x + o * Math.cos(gun.a), y: SHIP_Y - 6 + o * Math.sin(gun.a),
                    vx: sx * 1050, vy: sy * 1050, life: 0.95});
    });
    gun.heat += 7;
    if(gun.heat >= 100){ gun.heat = 100; gun.over = true; emit(S, 'gunhot'); }
    emit(S, 'shot');
  }

  // ----- the world -----
  var z = zoneOf(S.alt);
  if(z !== S.zone){
    S.zone = z;
    if(ZONE_NAMES[z]) emit(S, 'zone', {name: ZONE_NAMES[z], zone: z});
  }
  if(S.alt >= SPACE_KM && !S.boss && (S.sector.n === 0 || S.alt - S.sector.at >= SECTOR_KM)) newSector(S);
  flareTick(S, dt);
  if(S.phase !== 'flight') return;
  if(S.planet){
    S.planet.y += S.v * 0.07 * dt;
    if(S.planet.y - S.planet.r > H + 50) S.planet = null;
  }
  spawnTick(S, dt);

  var d = difficulty(S);
  for(var i = 0; i < S.objs.length; i++){
    var o = S.objs[i];
    o.t += dt;
    if(o.bump > 0) o.bump -= dt;
    if(o.kind === 'scout'){
      o.y += (S.v * 0.05 + 70) * dt;
      o.x += Math.sin(o.t * 1.6 + o.ph) * 160 * dt;
      o.fire -= dt;
      if(o.fire <= 0 && o.y > 0 && o.y < SHIP_Y - 120){
        o.fire = rr(r, 1.6, 2.8) / (1 + 0.15 * d);
        enemyShot(S, o, 300 + 30 * d, 7 * (1 + 0.2 * d));
      }
    } else if(o.kind === 'gunship'){
      if(o.hold > 0){ o.y += (180 - o.y) * 1.2 * dt; o.hold -= dt; }
      else o.y += 90 * dt;
      o.x += Math.sin(o.t * 0.7) * 60 * dt;
      o.fire -= dt;
      if(o.fire <= 0 && o.y > 40){
        enemyShot(S, o, 340 + 30 * d, 8 * (1 + 0.2 * d));
        o.burst++;
        if(o.burst >= 3){ o.burst = 0; o.fire = rr(r, 1.8, 2.6) / (1 + 0.1 * d); }
        else o.fire = 0.18;
      }
    } else if(o.kind === 'rammer'){
      var dx = S.x - o.x, dy = SHIP_Y - o.y, dl = Math.hypot(dx, dy) || 1;
      if(o.lock > 0){ o.lock -= dt; o.vx = dx / dl * 60; o.vy = dy / dl * 60; }
      else if(!o.dashing){ o.dashing = true; o.vx = dx / dl * (420 + 40 * d); o.vy = dy / dl * (420 + 40 * d); }
      o.x += o.vx * dt; o.y += o.vy * dt;
    } else if(o.kind === 'mother'){
      o.y += (215 - o.y) * 0.8 * dt;
      o.x = W / 2 + Math.sin(o.t * 0.35) * 480;
      o.leave -= dt;
      if(o.leave <= 0){ o.y -= 0; o.dead = true; S.boss = null; emit(S, 'bossgone', {name: o.name}); continue; }
      if(o.y > 60){
        o.volley -= dt; o.launch -= dt; o.torp -= dt;
        var rage = o.hp < o.maxHp * 0.4 ? 1.5 : 1;
        if(o.volley <= 0){
          o.volley = rr(r, 2.2, 3.0) / rage / (1 + 0.1 * d);
          var base = Math.atan2(S.x - o.x, SHIP_Y - o.y);
          for(var v = -2; v <= 2; v++){
            var aa = base + v * 0.22;
            S.ebolts.push({x: o.x, y: o.y + 50, vx: Math.sin(aa) * (280 + 25 * d), vy: Math.cos(aa) * (280 + 25 * d),
                           dmg: 7 * (1 + 0.2 * d), life: 4});
          }
          emit(S, 'eshot', {x: o.x, y: o.y});
        }
        if(o.launch <= 0){
          o.launch = rr(r, 5, 7) / rage;
          spawnObj(S, {kind: 'scout', x: o.x + rr(r, -60, 60), y: o.y + 40, r: 24, ride: 0,
                       hp: Math.ceil(3 * (1 + 0.3 * d)), dmg: 12, hostile: true, alien: true, cr: 3,
                       fire: rr(r, 1, 2), ph: rr(r, 0, 6)});
        }
        if(o.torp <= 0){
          o.torp = rr(r, 6, 8) / rage;
          spawnObj(S, {kind: 'torpedo', x: o.x, y: o.y + 60, r: 14, ride: 0, vx: 0, vy: 90,
                       hp: 2, dmg: 22 * (1 + 0.15 * d), hostile: true, cr: 2});
        }
      }
    } else if(o.kind === 'storm'){
      o.x += o.vx * dt;
      o.y += S.v * dt;
      o.zapT -= dt;
      if(o.zapT <= 0){
        o.zapT = rr(r, 0.9, 1.6);
        var zd = Math.hypot(o.x - S.x, o.y - SHIP_Y);
        if(zd < o.r + 170){
          emit(S, 'zap', {x: S.x, y: SHIP_Y, from: {x: o.x, y: o.y}, bolt: true});
          hurt(S, 7, o, 'lightning');
          if(S.phase !== 'flight') return;
        }
      }
    } else if(o.kind === 'torpedo'){
      var tx2 = S.x - o.x, ty2 = SHIP_Y - o.y, tl = Math.hypot(tx2, ty2) || 1, sp = 170 + 12 * d;
      o.vx += (tx2 / tl * sp - o.vx) * 1.2 * dt;
      o.vy += (ty2 / tl * sp - o.vy) * 1.2 * dt;
      o.x += o.vx * dt; o.y += o.vy * dt;
    } else if(o.kind === 'chaser'){
      var cdx = S.x - o.x;
      o.vx += clamp(cdx * 2, -500, 500) * dt;
      o.vx *= 1 - 0.8 * dt;
      o.x += o.vx * dt;
      o.y -= (110 + 15 * d) * dt;
    } else {
      o.x += o.vx * dt;
      o.y += (S.v * o.ride + o.vy) * dt;
      if(o.spin) o.rot += o.spin * dt;
    }
    if(o.y > H + 140 || o.y < -260 || o.x < -260 || o.x > W + 260 || (o.t > 60 && !o.boss)) o.dead = true;
    if(o.dead) continue;
    // touching the ship
    var cr = o.r + SHIP_R * 0.8;
    if(Math.abs(o.x - S.x) < cr && Math.abs(o.y - SHIP_Y) < cr &&
       Math.hypot(o.x - S.x, o.y - SHIP_Y) < cr){
      if(o.avoid) continue;               // a thundercloud is not solid
      if(o.boss){
        if(!(o.bump > 0)){ o.bump = 1; hurt(S, o.dmg, o, 'mother'); if(S.phase !== 'flight') return; }
        continue;
      }
      o.dead = true;
      if(o.hostile){
        emit(S, 'boom', {x: o.x, y: o.y, r: o.r, kind: o.kind, crash: true});
        hurt(S, o.dmg, o, o.kind === 'rock' ? 'rock' : o.kind === 'junk' ? 'junk' : o.kind);
        if(S.phase !== 'flight') return;
      } else pickup(S, o);
    }
  }

  // our bolts
  for(i = 0; i < S.bolts.length; i++){
    var b = S.bolts[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if(b.life <= 0){ b.dead = true; continue; }
    for(var j = 0; j < S.objs.length; j++){
      var q = S.objs[j];
      if(q.dead || !q.hostile) continue;
      if(Math.abs(q.x - b.x) < q.r + 6 && Math.abs(q.y - b.y) < q.r + 6 &&
         Math.hypot(q.x - b.x, q.y - b.y) < q.r + 6){
        b.dead = true;
        q.hp -= st.dmg;
        emit(S, 'zap', {x: b.x, y: b.y});
        if(q.hp <= 0) kill(S, q);
        break;
      }
    }
  }
  // theirs
  for(i = 0; i < S.ebolts.length; i++){
    var e = S.ebolts[i];
    e.x += e.vx * dt; e.y += e.vy * dt; e.life -= dt;
    if(e.life <= 0){ e.dead = true; continue; }
    if(Math.hypot(e.x - S.x, e.y - SHIP_Y) < SHIP_R * 0.85){
      e.dead = true;
      // the side is where the shot came FROM, not where it landed
      hurt(S, e.dmg, {x: S.x - e.vx * 0.2, y: SHIP_Y - e.vy * 0.2}, 'bolt');
      if(S.phase !== 'flight') return;
    }
  }
  S.objs = S.objs.filter(function(o){ return !o.dead; });
  S.bolts = S.bolts.filter(function(o){ return !o.dead; });
  S.ebolts = S.ebolts.filter(function(o){ return !o.dead; });
}

function enemyShot(S, o, speed, dmg){
  var dx = S.x - o.x, dy = SHIP_Y - o.y, dl = Math.hypot(dx, dy) || 1;
  var wob = rr(S.rng, -0.12, 0.12), c = Math.cos(wob), s = Math.sin(wob);
  var ux = dx / dl, uy = dy / dl;
  S.ebolts.push({x: o.x, y: o.y, vx: (ux * c - uy * s) * speed, vy: (ux * s + uy * c) * speed,
                 dmg: dmg, life: 4});
  emit(S, 'eshot', {x: o.x, y: o.y});
}

function pickup(S, o){
  S.stats.pickups++;
  if(o.kind === 'fuel') S.fuel = Math.min(S.st.fuelMax, S.fuel + 35);
  else if(o.kind === 'repair') S.hull = Math.min(S.st.hullMax, S.hull + 22);
  else if(o.kind === 'gem') S.stats.gems++;
  else if(o.kind === 'battery'){ S.E = S.st.Emax; S.gun.heat = 0; S.gun.over = false; S.heat = Math.max(0, S.heat - 40); }
  emit(S, 'pickup', {kind: o.kind, x: o.x, y: o.y});
}

/* What a run is worth in the hangar. */
function credits(S){
  return Math.floor(S.maxAlt / 10) + Math.round(S.stats.killCr * 0.5) + S.stats.gems * 8;
}

/* ---------- the computer crew ----------
   Competent, never good. A person in the seat should beat it, which is the
   reason to bring one more person into the game. Fills `inp` for the
   stations it holds and returns any actions it wants to take. */
function ai(S, auto, inp, dt){
  var acts = [], r = S.airng, A = S.ai;

  if(auto.thrusters){
    var t;
    if(S.alt < SPACE_KM){
      // just under the red line, backing off through Max-Q and when hot
      t = 0.74;
      if(S.alt > MAXQ[0] - 2 && S.alt < MAXQ[1] && S.v > MAXQ_V - 25) t = 0.55;
      if(S.heat > 70) t = 0.62;
    } else {
      t = 0.62;
      if(S.heat > 65) t = 0.6;
      if(S.fuel < 20) t = 0.45;
    }
    inp.thr = t;
    if(S.stageDue && !S.staged){
      A.stageWait = (A.stageWait || 0) + dt;
      if(A.stageWait > 1.8) acts.push({t: 'stage'});
    }
  }

  if(auto.pilot){
    A.pilot.t -= dt;
    if(A.pilot.t <= 0){
      A.pilot.t = 0.28;
      var best = S.x, bestScore = -1e9;
      for(var cx = 80; cx <= W - 80; cx += 40){
        var score = -Math.abs(cx - S.x) * 0.012 - Math.abs(cx - W / 2) * 0.002;
        for(var i = 0; i < S.objs.length; i++){
          var o = S.objs[i];
          var ahead = SHIP_Y - o.y;
          if(ahead < -60 || ahead > 480) continue;
          var gap = Math.abs(o.x - cx) - o.r - SHIP_R;
          if(o.avoid){ if(gap < 120) score -= (120 - gap) * 0.25; }
          else if(o.hostile){ if(gap < 40) score -= (40 - gap) * (1.6 - ahead / 480); }
          else if(gap < 20) score += o.kind === 'repair' && S.hull < S.st.hullMax * 0.7 ? 30 : 12;
        }
        if(score > bestScore){ bestScore = score; best = cx; }
      }
      A.pilot.px = clamp((best - S.x) / 160, -1, 1) * 0.85;
    }
    inp.px = A.pilot.px;
  }

  if(auto.gunner){
    var G = A.gunner;
    G.t -= dt;
    if(G.t <= 0){
      G.t = 0.4;
      var tgt = null, bd = 1e9;
      for(var k = 0; k < S.objs.length; k++){
        var q = S.objs[k];
        if(!q.hostile || q.y < -20) continue;
        var dd = Math.hypot(q.x - S.x, q.y - SHIP_Y) - (q.alien ? 150 : 0) - (q.kind === 'torpedo' ? 400 : 0);
        if(dd < bd && dd < 650){ bd = dd; tgt = q; }
      }
      G.target = tgt;
      G.noise = rr(r, -0.12, 0.12);
    }
    var want = S.gun.a;
    if(G.target && !G.target.dead){
      var tq = G.target, dist = Math.hypot(tq.x - S.x, tq.y - SHIP_Y), tt = dist / 1050;
      var lx = tq.x + (tq.vx || 0) * tt, ly = tq.y + ((tq.vy || 0) + S.v * (tq.ride || 0)) * tt;
      want = Math.atan2(lx - S.x, -(ly - SHIP_Y)) + (G.noise || 0);
    } else want = 0;
    var da = Math.atan2(Math.sin(want - S.gun.a), Math.cos(want - S.gun.a));
    var turn = 3.5 * dt;
    inp.ga = S.gun.a + clamp(da, -turn, turn);
    inp.gf = !!(G.target && !G.target.dead && Math.abs(da) < 0.2 && S.gun.heat < 75);
  }

  if(auto.shields){
    A.shields.t -= dt;
    // a flare: the computer gets there, a little late
    if(S.flare){
      A.shields.flareSeen += dt;
      if(A.shields.flareSeen > 1.6){
        if(S.side !== S.flare.side) acts.push({t: 'side', s: S.flare.side});
        return acts;
      }
    } else A.shields.flareSeen = 0;
    if(A.shields.t <= 0){
      A.shields.t = 0.55;
      var worst = null, wt = 1e9;
      function consider(x, y, vx, vy){
        var dx = S.x - x, dy = SHIP_Y - y, dist = Math.hypot(dx, dy);
        var closing = (vx * dx + vy * dy) / (dist || 1);
        if(closing <= 10 || dist > 520) return;
        var tti = dist / closing;
        if(tti < wt){ wt = tti; worst = {x: x, y: y}; }
      }
      S.objs.forEach(function(o){
        if(!o.hostile) return;
        consider(o.x, o.y, (o.vx || 0) - S.vx, (o.vy || 0) + S.v * o.ride);
      });
      S.ebolts.forEach(function(e){ consider(e.x, e.y, e.vx - S.vx, e.vy); });
      if(worst){
        var sd = sideOf(S, worst.x, worst.y);
        if(sd !== S.side) acts.push({t: 'side', s: sd});
      }
      var spare = S.st.pipMax - 6;
      var want2 = {s: 2 + spare, w: 2, e: 2};
      if(S.pips.s !== want2.s || S.pips.w !== want2.w || S.pips.e !== want2.e)
        acts.push({t: 'pips', s: Math.min(5, want2.s), w: 2, e: 2});
    }
  }
  return acts;
}

/* ---------- the hangar ---------- */
function cost(lv, key){ var l = lv[key] || 0; return l >= MAX_LV ? null : COSTS[l]; }
function buy(save, key){
  var c = cost(save.lv, key);
  if(c == null || save.credits < c) return false;
  save.credits -= c;
  save.lv[key]++;
  return true;
}

/* Who runs which station: people first, in the priority order, then the
   computer takes the rest. `crew` maps station -> person id or null. */
function assign(crew, people, prefer){
  var out = {}, taken = {};
  STATIONS.forEach(function(s){ out[s] = null; });
  // keep anybody already where they are, then anybody who asked for a seat
  STATIONS.forEach(function(s){
    var id = crew && crew[s];
    if(id && people.indexOf(id) >= 0 && !taken[id]){ out[s] = id; taken[id] = 1; }
  });
  people.forEach(function(id){
    if(taken[id]) return;
    var want = prefer && prefer[id];
    if(want && out[want] === null){ out[want] = id; taken[id] = 1; }
  });
  people.forEach(function(id){
    if(taken[id]) return;
    for(var i = 0; i < STATIONS.length; i++)
      if(out[STATIONS[i]] === null){ out[STATIONS[i]] = id; taken[id] = 1; break; }
  });
  return out;
}

var MC = {W: W, H: H, SHIP_Y: SHIP_Y, SHIP_R: SHIP_R, PX_PER_KM: PX_PER_KM, SPACE_KM: SPACE_KM,
          ATM_PX_PER_KM: ATM_PX_PER_KM, STAGE_KM: STAGE_KM, MAXQ: MAXQ, MAXQ_V: MAXQ_V, altPx: altPx,
          SECTOR_KM: SECTOR_KM, STATIONS: STATIONS, SIDES: SIDES, UPGRADES: UPGRADES,
          COSTS: COSTS, MAX_LV: MAX_LV, PAINTS: PAINTS, difficultyAt: function(km){ return Math.max(0, km - SPACE_KM) / 600; },
          freshLevels: freshLevels, stats: stats, newRun: newRun, step: step, act: act,
          ai: ai, credits: credits, difficulty: difficulty, cost: cost, buy: buy,
          assign: assign, sideOf: sideOf, mulberry: mulberry};
root.MC = MC;
if(typeof module !== 'undefined' && module.exports) module.exports = MC;
})(typeof window !== 'undefined' ? window : globalThis);
