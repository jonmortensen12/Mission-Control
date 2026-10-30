// node tools/art.mjs - redraw the app icons and the link-preview image from
// the game's own renderer, so they always look like the ship in the game.
// Writes web/icon-192.png, web/icon-512.png and web/og.png.
import {createRequire} from 'module';
import http from 'http'; import fs from 'fs'; import path from 'path';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const ROOT = path.resolve('web');
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url.split('?')[0].split('#')[0]);
  if(!p.startsWith(ROOT) || !fs.existsSync(p)){ res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type': p.endsWith('.html') ? 'text/html' : 'text/javascript'});
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const B = 'http://localhost:' + server.address().port + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (file, url) => fs.writeFileSync(path.join(ROOT, file), Buffer.from(url.split(',')[1], 'base64'));

const br = await chromium.launch();
const pg = await br.newPage();
await pg.setViewportSize({width: 1600, height: 900});
await pg.goto(B + 'index.html?local=1');
await sleep(500);

// the icons: the ship, mid-upgrade, on a night sky
for(const size of [512, 192]){
  const url = await pg.evaluate(size => {
    draw = () => {};
    SAVE.paint = 'classic';
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const old = cv.width;
    cv.width = 512; cv.height = 512;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const bg = g.createRadialGradient(256, 200, 20, 256, 256, 360);
    bg.addColorStop(0, '#1a2a6c'); bg.addColorStop(1, '#03040a');
    g.fillStyle = bg; g.fillRect(0, 0, 512, 512);
    const r = MC.mulberry(9);
    for(let i = 0; i < 70; i++){ g.fillStyle = 'rgba(255,255,255,' + (0.3 + r() * 0.7) + ')'; g.fillRect(r() * 512, r() * 512, 2, 2); }
    g.strokeStyle = 'rgba(255,213,79,0.85)'; g.lineWidth = 14;
    g.beginPath(); g.ellipse(256, 280, 200, 70, -0.35, 0, 6.283); g.stroke();
    Math.random = () => 0.5;            // a steady flame
    drawShip(256, 250, {hull: 2, eng: 2, laser: 1, shield: 0, reactor: 1}, null, 3.3);
    c.getContext('2d').drawImage(cv, 0, 0);
    const out = document.createElement('canvas'); out.width = out.height = size;
    out.getContext('2d').drawImage(c, 0, 0, size, size);
    return out.toDataURL('image/png');
  }, size);
  save('icon-' + size + '.png', url);
}
await pg.close();

// the link preview: a real moment of flight with the title over it
const tv = await br.newPage();
await tv.setViewportSize({width: 1600, height: 900});
await tv.goto(B + 'index.html?local=1');
await sleep(500);
await tv.evaluate(() => { SAVE.paint = 'classic'; SAVE.record = 0; SAVE.lv = {hull: 3, eng: 2, laser: 3, shield: 2, reactor: 1}; launch(); });
await sleep(4500);
await tv.evaluate(() => {
  drawHud = () => {};
  G.S.hull = 1e6; G.S.alt = 100 + MC.SECTOR_KM * 2 + 5; G.S.maxAlt = G.S.alt; G.S.lifted = true; G.S.v = 260;
  G.S.sector = {n: 2, at: 100 + MC.SECTOR_KM, theme: 'belt', name: 'x'};
});
await sleep(1000);
// the mothership has to be in the picture, not shot down before it arrives
await tv.evaluate(() => { if(G.S.boss){ G.S.boss.hp = G.S.boss.maxHp = 1e6; } });
await sleep(6000);
// and below the title rather than behind it
await tv.evaluate(() => { if(G.S.boss){ G.S.boss.y = 330; G.S.boss.x = 980; } });
await sleep(30);
const shot = (await tv.screenshot({clip: {x: 0, y: 30, width: 1600, height: 840}})).toString('base64');
const og = await tv.evaluate(async shot => {
  const img = new Image(); img.src = 'data:image/png;base64,' + shot; await img.decode();
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
  const q = c.getContext('2d');
  q.drawImage(img, 0, 0, 1200, 630);
  const gr = q.createLinearGradient(0, 0, 0, 260); gr.addColorStop(0, 'rgba(3,4,12,0.85)'); gr.addColorStop(1, 'rgba(3,4,12,0)');
  q.fillStyle = gr; q.fillRect(0, 0, 1200, 260);
  q.textAlign = 'center'; q.fillStyle = '#fff'; q.font = 'bold 92px system-ui, sans-serif';
  q.shadowColor = 'rgba(0,0,0,0.8)'; q.shadowBlur = 12;
  q.fillText('MISSION CONTROL', 600, 110);
  q.font = '34px system-ui, sans-serif'; q.fillStyle = '#b3e5fc';
  q.fillText('Fly a rocket into space together. Your phone is the controls.', 600, 165);
  return c.toDataURL('image/png');
}, shot);
save('og.png', og);
await br.close();
server.close();
console.log('wrote web/icon-192.png, web/icon-512.png, web/og.png');
