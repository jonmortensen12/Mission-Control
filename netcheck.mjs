// node netcheck.mjs - the TV and five phones, in headless Chromium, the way
// a family drives them. Uses ?local=1 (BroadcastChannel between tabs), so it
// needs no internet and no PeerJS broker; everything above the transport is
// the real code.
//
//   - four phones join and get the four stations in priority order
//   - a fifth joins and gets no seat
//   - everyone READY launches the countdown, then the flight
//   - each station's controls move the ship: stick, throttle, turret, shield
//   - a phone that reloads mid-flight gets its own seat back
//   - the ship dies, the phones show the results, CONTINUE goes back to the
//     hangar, the credits arrive, and a phone can buy an upgrade
import {createRequire} from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');

const ROOT = path.resolve('web');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png'};
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/\/$/, '/index.html'));
  if(!p.startsWith(ROOT) || !fs.existsSync(p)){ res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type': TYPES[path.extname(p)] || 'application/octet-stream'});
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://localhost:' + server.address().port + '/';

let fails = 0;
function ok(cond, msg){ console.log((cond ? '  ok   ' : '  FAIL ') + msg); if(!cond) fails++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000){
  const end = Date.now() + ms;
  while(Date.now() < end){ try { if(await fn()) return true; } catch(e){} await sleep(50); }
  return false;
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const errors = [];
const watch = (pg, who) => {
  pg.on('pageerror', e => errors.push(who + ': ' + e.message));
  pg.on('console', m => { if(m.type() === 'error') errors.push(who + ': ' + m.text()); });
};

try {
  const tv = await ctx.newPage();
  await tv.setViewportSize({width: 1280, height: 720});
  watch(tv, 'tv');
  await tv.goto(BASE + 'index.html?local=1');
  ok(await until(() => tv.evaluate(() => !!NET.code)), 'the TV opens a room');
  const code = await tv.evaluate(() => NET.code);

  const names = ['Ana', 'Ben', 'Cal', 'Dee', 'Eve'];
  const phones = [];
  for(const n of names){
    const p = await ctx.newPage();
    await p.setViewportSize({width: 844, height: 390});    // a phone held sideways
    watch(p, n);
    await p.goto(BASE + 'controller.html?local=1#' + code);
    await p.fill('#nameIn', n);
    await p.click('#joinBtn');
    phones.push(p);
    await until(() => p.evaluate(() => !!conn && st !== undefined));
    await sleep(150);
  }
  ok(await until(() => tv.evaluate(() => Object.keys(NET.people).length === 5)), 'five phones in the room');
  const crew = await tv.evaluate(() => Object.fromEntries(MC.STATIONS.map(s => [s, G.crew[s] && NET.people[G.crew[s]].name])));
  ok(crew.pilot === 'Ana' && crew.shields === 'Ben' && crew.gunner === 'Cal' && crew.thrusters === 'Dee',
     'seats in priority order: ' + JSON.stringify(crew));
  ok(await until(() => phones[4].evaluate(() => st === null && $('chip').textContent === 'NO SEAT')), 'the fifth phone has no seat and says so');
  ok(await phones[2].evaluate(() => $('chip').textContent === 'GUNNER'), 'a phone knows its station');

  // a seat can be swapped in the hangar: Eve cannot take a seat somebody holds
  await phones[4].click('.seat[data-s="pilot"]');
  await sleep(300);
  ok(await tv.evaluate(() => NET.people[G.crew.pilot].name === 'Ana'), 'a held seat cannot be taken');

  // the shop starts empty; ready up
  for(const p of phones) await p.click('#readyBtn');
  ok(await until(() => tv.evaluate(() => G.phase === 'count' || G.phase === 'flight')), 'everyone READY starts the countdown');
  ok(await until(() => tv.evaluate(() => G.phase === 'flight'), 6000), 'and then the flight');
  ok(await until(() => phones[0].evaluate(() => $('pilot').classList.contains('on'))), 'the pilot sees the stick');

  // keep the ship alive while we poke at it
  await tv.evaluate(() => { G.S.hull = 1e6; });

  // pilot: drag right and hold
  const P = phones[0], box = await P.locator('#stick').boundingBox();
  const x0 = await tv.evaluate(() => G.S.x);
  await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await P.mouse.down();
  await P.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, {steps: 4});
  await sleep(600);
  const x1 = await tv.evaluate(() => G.S.x);
  await P.mouse.up();
  ok(x1 > x0 + 60, 'the pilot steers right (' + Math.round(x0) + ' -> ' + Math.round(x1) + ')');
  await sleep(300);
  ok(await tv.evaluate(() => NET.people[G.crew.pilot].inp.px === 0), 'letting go centres the stick');

  // thrusters: throttle to the bottom
  const T = phones[3], tb = await T.locator('#throttle').boundingBox();
  await T.mouse.click(tb.x + tb.width / 2, tb.y + tb.height * 0.9);
  ok(await until(() => tv.evaluate(() => G.S.thr < 0.2)), 'the throttle comes down');
  await T.mouse.click(tb.x + tb.width / 2, tb.y + tb.height * 0.35);
  ok(await until(() => tv.evaluate(() => G.S.thr > 0.6)), 'and goes back up');
  await T.click('#boostBtn');
  ok(await until(() => tv.evaluate(() => G.S.stats.boosts === 1)), 'BOOST fires the boosters');

  // gunner: hold to the right
  const Gp = phones[2], ab = await Gp.locator('#aim').boundingBox();
  await Gp.mouse.move(ab.x + ab.width * 0.95, ab.y + ab.height / 2);
  await Gp.mouse.down();
  ok(await until(() => tv.evaluate(() => Math.abs(G.S.gun.a - Math.PI / 2) < 0.15 && G.S.bolts.length > 0)), 'the gunner aims right and fires');
  await Gp.mouse.up();
  await sleep(400);
  ok(await tv.evaluate(() => !NET.people[G.crew.gunner].inp.gf), 'letting go stops the firing');

  // shields: turn left, and power to the engines
  const Sh = phones[1];
  await Sh.click('.sideBtn[data-s="L"]');
  ok(await until(() => tv.evaluate(() => G.S.side === 'L')), 'the shield turns left');
  const e0 = await tv.evaluate(() => G.S.pips.e);
  await Sh.click('.prow[data-k="e"] button[data-d="1"]');
  ok(await until(() => tv.evaluate(e0 => G.S.pips.e === e0 + 1, e0)), 'a pip goes to the engines');
  // the wrong station cannot do it
  await T.evaluate(() => tx({t: 'act', a: {t: 'side', s: 'R'}}));
  await sleep(300);
  ok(await tv.evaluate(() => G.S.side === 'L'), 'thrusters cannot move the shield');

  // pause from any phone, resume from another
  await P.click('#pauseBtn');
  ok(await until(() => tv.evaluate(() => G.paused)), 'a phone pauses the game');
  const t0 = await tv.evaluate(() => G.S.t);
  await sleep(500);
  ok(await tv.evaluate(t0 => G.S.t === t0, t0), 'and the ship stops');
  ok(await until(() => Sh.evaluate(() => $('paused').classList.contains('on'))), 'every phone shows PAUSED');
  await Sh.click('#resumeBtn');
  ok(await until(() => tv.evaluate(() => !G.paused)), 'another phone resumes it');

  // a solar flare: the shields phone is told which way to turn
  await tv.evaluate(() => { G.S.alt = Math.max(G.S.alt, 200); G.S.flareT = 0.01; G.S.side = 'F'; });
  ok(await until(() => tv.evaluate(() => !!G.S.flare)), 'a flare is coming');
  const fside = await tv.evaluate(() => G.S.flare.side);
  if(fside !== 'F'){
    ok(await until(() => Sh.evaluate(s => document.querySelector('.sideBtn[data-s="' + s + '"]').classList.contains('flare'), fside)), 'the shields phone flashes the side to turn to');
    ok(await until(() => T.evaluate(() => /SOLAR FLARE/.test($('note').textContent))), 'and the other phones are told to shout');
  }
  await Sh.click('.sideBtn[data-s="' + fside + '"]');
  ok(await until(() => Sh.evaluate(() => /BLOCKED/.test($('flareMsg').textContent))), 'turning to it says it is blocked');
  await until(() => tv.evaluate(() => !G.S.flare), 8000);

  // a phone that reloads gets its seat back
  await Gp.reload();
  ok(await until(() => Gp.evaluate(() => !!conn && st === 'gunner'), 8000), 'the gunner reloads and is the gunner again');
  ok(await tv.evaluate(() => NET.people[G.crew.gunner].name === 'Cal'), 'with the same name on the TV');

  // the end of the run
  const cr0 = await tv.evaluate(() => SAVE.credits);
  await tv.evaluate(() => { G.S.hull = 1; G.S.ebolts.push({x: G.S.x, y: MC.SHIP_Y - 10, vx: 0, vy: 300, dmg: 999, life: 1}); G.S.side = 'B'; });
  ok(await until(() => tv.evaluate(() => G.phase === 'dead')), 'the ship is destroyed');
  ok(await until(() => P.evaluate(() => $('results').classList.contains('on') && /km/.test($('rKm').textContent))), 'the phones show the results');
  ok(await tv.evaluate(cr0 => SAVE.credits === cr0 + G.last.earned && SAVE.runs === 1, cr0), 'the run is banked');
  await sleep(2200);
  await P.click('#contBtn');
  ok(await until(() => tv.evaluate(() => G.phase === 'hangar')), 'CONTINUE goes back to the hangar');

  await tv.evaluate(() => { SAVE.credits = 1000; SAVE.record = 600; });
  await sleep(250);
  ok(await until(() => Sh.evaluate(() => !document.querySelector('.paint[data-k="midnight"]').disabled && document.querySelector('.paint[data-k="tiger"]').disabled)),
     'paint jobs unlock with the record');
  await Sh.click('.paint[data-k="midnight"]');
  ok(await until(() => tv.evaluate(() => SAVE.paint === 'midnight')), 'a phone picks the Midnight paint');
  await Sh.evaluate(() => tx({t: 'paint', key: 'ghost'}));
  await sleep(250);
  ok(await tv.evaluate(() => SAVE.paint === 'midnight'), 'a locked paint cannot be picked');
  await sleep(250);
  await Sh.click('.item[data-k="shield"] button');
  ok(await until(() => tv.evaluate(() => SAVE.lv.shield === 1 && SAVE.credits === 1000 - MC.COSTS[0])), 'a phone buys a shield upgrade');
  ok(await until(() => Sh.evaluate(() => document.querySelectorAll('.item[data-k="shield"] .lvl i.f').length === 1)), 'and the phone shows the new level');
  ok(await tv.evaluate(() => JSON.parse(localStorage.getItem('mctl_save')).lv.shield === 1), 'and the TV saves it');

  // a phone leaving hands its seat to the computer
  await phones[3].close();
  ok(await until(() => tv.evaluate(() => { const p = NET.people[G.crew.thrusters]; return !p || !p.conn; })), 'a phone that closes frees its seat for the computer');
  // and one that just goes quiet does too, then gets it back when it speaks
  await phones[0].evaluate(() => { window._tx = tx; tx = () => {}; });
  ok(await until(() => tv.evaluate(() => !NET.people[G.crew.pilot].conn), 9000), 'a phone silent for six seconds is treated as away');
  await phones[0].evaluate(() => { tx = window._tx; });
  ok(await until(() => tv.evaluate(() => !!NET.people[G.crew.pilot].conn && NET.people[G.crew.pilot].name === 'Ana')), 'and has its seat back when it speaks again');

  ok(errors.length === 0, 'no errors on any page' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
} catch(e){
  console.log('  FAIL threw: ' + (e && e.stack || e));
  fails++;
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
