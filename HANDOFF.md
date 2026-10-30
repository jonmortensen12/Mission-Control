# Mission Control — handoff

A co-op rocket game for the TV. Up to four people are the crew of one ship;
each phone is a station on the bridge. Launch, climb out of the atmosphere,
and keep going into space until the ship is destroyed. Distance is the
score; credits buy upgrades between runs; the family record is a line
across the sky.

Built from the plan agreed in conversation (2026-10-30): 2D, vertical,
four stations, endless and procedurally generated, harder the further you
go, phones as controllers the way Family Beatdown does it.

## Files

| File | What it is |
|---|---|
| `web/index.html` | The TV. Hosts the room, runs the clock, draws everything, plays the sounds. |
| `web/controller.html` | The phone. One page for every station. |
| `web/sim.js` | The simulation. Pure, deterministic, no drawing. Loaded by both pages and by `simcheck`. |
| `web/net.js` | The connection: PeerJS (WebRTC) normally, BroadcastChannel with `?local=1`. |
| `web/qr.js` | QR encoder, copied from Family Beatdown so the join code needs no CDN. |
| `simcheck.mjs` | Headless simulation checks and tuning bounds. |
| `netcheck.mjs` | The TV and five phones in Chromium, end to end. |

## Playing it without phones

- `index.html` and press **Enter**: the computer crews every station; arrow
  keys (or A/D) steer once pressed. **M** mutes, **F** fullscreen.
- `index.html?local=1` plus `controller.html?local=1#CODE` in other tabs of
  the same browser: real phone pages, no internet. This is what `netcheck`
  drives, and the quickest way to try a station change on a laptop.

## The stations

The order is the priority order: one person flies, the second takes
shields, and so on. The computer runs whatever nobody holds — competent,
never good, so one more person always helps. A phone can take any station
the computer holds by tapping it in the hangar (or mid-flight).

- **Pilot** — a floating stick: wherever the thumb lands is centre, a short
  drag is full lock. Dodges, and collects pickups (green fuel, red repair,
  pink gems worth 8 credits).
- **Shields** — which side the shield faces (front/right/back/left), and the
  power split. The reactor has `6 + reactor level` pips shared between
  shields (regen), lasers (cooling; zero pips means no firing) and engines
  (thrust and how quickly the ship turns). A `+` on a full reactor takes a
  pip from whichever other system has most, so the button always does
  something. This is the station that makes people argue, which is the
  point.
- **Gunner** — touch the circle where you want to shoot, hold to keep
  firing. Full 360°, because chasers come from behind. Laser heat; overheat
  locks the gun until it cools to 40.
- **Thrusters** — throttle (stays where it is put), boost, engine heat and
  fuel. Above 75% throttle the engines heat; at 100 they stall for three
  seconds. In the atmosphere, too little throttle and gravity wins: the
  ship falls back to Earth, which ends the run.

Damage is sided. A hit counts from the side it came from (a bolt: the
direction it was travelling from), and only the shield on that side
absorbs it.

## The run

- **Countdown**, then liftoff from a pad with a tower.
- **Atmosphere, 0–100 km**: birds, planes crossing, weather balloons, then
  junk near the top. Gravity fades with height. Zone banners: Clouds,
  Stratosphere, Mesosphere, SPACE!
- **Space, 100 km on**: a new sector every 400 km. Sector 1 is always Low
  Orbit. After that the theme is drawn from belt (rocks), patrol (aliens),
  flyby (a named planet whose gravity pulls the ship sideways), ion storm
  (shield regen cut to a third), drift (a breather, more pickups), and past
  difficulty 2.5, nest (lots of aliens). Never the same theme twice running.
- **Enemies by distance** (`d = (km − 100) / 600`): scouts from the start
  (zig-zag and shoot), gunships from d 0.8 (park at the top and fire
  bursts), rammers from d 1.3 (lock on, flash, then dash — from the sides),
  chasers from d 1.9 (come up from behind). Rock size, hit points, damage,
  fire rate and spawn rate all scale with d.
- **Death**: results screen with distance, cause, record, credits, and one
  line per station saying what that person did.

## Tuning (as of the first build)

`node simcheck.mjs` prints these; they are also its pass bounds.

- Fresh ship, computer crew: ~800 km mean, ~3 minutes, ~170 credits.
- Fully upgraded, computer crew: ~1650 km.
- Upgrade costs `COSTS = [80, 180, 340, 560, 850]` per level, five levels
  each across five tracks: about 10,000 credits to max everything, so
  roughly 25–50 runs. Credits are `km/10 + half the kill bounty + 8 per gem`.

People will do better and worse than the computer; these numbers are a
starting point to retune after a family playtest, not a finished balance.

## The phone ↔ TV protocol (`PROTO` 1)

Phone → TV: `hello {name, dev, proto}`, `in {px | thr | ga, gf}` (the
station's continuous controls, sent the moment they change and re-sent
every 150 ms), `act {a: side | boost | pip}`, `pick {st}`, `buy {key}`,
`ready {v}`, `ping` (a seatless phone, once a second).

TV → phone: `host {proto, min}`, `you {st}`, `s {...}` (the ship's state,
ten times a second), `fx {k: hit | block | stall | gunhot | dead}` for
vibration.

A phone below the TV's `min` reloads itself. Bump both `PROTO`s and
`PROTO_MIN` together when a message changes shape.

The TV only accepts a station's actions from the phone that holds it — a
thrusters phone cannot move the shield.

## Things already learned (some of them from Family Beatdown)

- **The clock is `setInterval`, not `requestAnimationFrame`.** rAF is a paint
  rate. The simulation steps at a fixed 60 Hz from real elapsed time.
- **A thumb never waits for a frame.** Phone input goes out on the pointer
  event, not on the next animation frame.
- **Every drag lets go however it ends**: `pointerup`, `pointercancel` and
  `lostpointercapture`. A phone that changes seats, loses the connection or
  is backgrounded releases the stick and the trigger.
- **Inputs are 18 px** so iOS does not zoom in on focus and stay zoomed.
- **A phone that goes quiet for six seconds is treated as away** and the
  computer takes its station; WebRTC can take far longer to notice by
  itself. Away for thirty seconds and the seat is let go for good. A phone
  that comes back (same device id) gets its own seat back.
- **Local mode keeps the phone's memory per tab** (sessionStorage), because
  every "phone" is a tab of one browser. Without that, tab two joined with
  tab one's identity.

## Not built yet

- **No relay (TURN).** Same as early Family Beatdown: a guest network, a
  router that keeps devices apart, or a phone on mobile data will fail to
  connect. Family Beatdown's fix is `/demo?relay=1` in its Worker handing
  out Cloudflare TURN credentials (`relay.js`); port that when there is a
  Worker.
- **No licence gate, no landing page, no trailer.** Step 6 of the plan.
- **Not tried on a real phone, TV or Fire Stick.** Everything is verified
  headless only. The first family playtest is the real test of whether
  each station is fun to hold.
- **Sound is on the TV only and needs one key press or click first**
  (browser autoplay rules). No music.
- **Open question from the plan:** if Thrusters turns out to be the boring
  seat in playtesting, the fallback is an Engineer station (repairs, fires,
  rerouting power).
