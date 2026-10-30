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
| `web/manifest.webmanifest`, `icon-*.png`, `og.png` | Install icon and link preview. Drawn by `tools/art.mjs` from the game's own renderer — rerun it after changing how the ship looks. |
| `worker.js` | Serves `/relay` (Cloudflare TURN passes); everything else is a plain file from `web/`. |
| `simcheck.mjs` | Headless simulation checks and tuning bounds. |
| `netcheck.mjs` | The TV and five phones in Chromium, end to end. |

## Playing it without phones

- `index.html` and press **Enter**: the computer crews every station; arrow
  keys (or A/D) steer once pressed. **P** pauses, **M** mutes, **F**
  fullscreen.
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
  pink gems worth 8 credits). **Shares the engines with Thrusters**
  (asked for): steering burns the same fuel and adds to the same engine
  heat, in proportion to how hard the ship is swung, so a wild pilot can
  stall the engines and a hot engine is a reason to fly smooth. The
  pilot's phone shows both gauges. Stalled or dry, steering is weak.
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
- **Atmosphere, 0–100 km** — asked for: "longer and a bit more difficult,
  turbulence or the boosters being more important (overheat and you fall
  back to the earth)". About 75 s for a fresh ship (was 28): drawn at 110 px
  a kilometre where space is 50 (`altPx` maps altitude to scroll for the
  TV). Gravity `40 + 120 × (1 − alt/100)`: at the pad the engines need ~45%
  just to hover, so a stall low down falls back to Earth, which ends the
  run; thick air heats the engines above 60% throttle. Hazards: geese in Vs,
  planes, balloons, junk near the top, thunderclouds (3–20 km: not solid,
  but lightning hits anything within reach, from the cloud's side, so the
  shield can take it), gusts every 1.5–4 s and the jet stream (8–14 km, a
  steady push right). **Max-Q** (10–26 km): faster than 175 px/s there
  costs hull, with a gauge on the TV and a warning on the thrusters phone —
  it bites once the engines are upgraded. **Staging** at 45 km: the booster
  runs dry, the ship is at half thrust until the thrusters officer hits
  STAGE (only that phone can). The computer stages after 1.8 s. Zone
  banners: Clouds, Stratosphere, Mesosphere, SPACE!
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
- **Every third sector is a mothership** (3, 6, 9...). It parks across the
  top, sweeps side to side, fires fans of five shots, launches scouts and
  sends slow homing torpedoes the gunner has to shoot down; below 40% it
  turns red and attacks faster. The sector does not end while it lives. It
  leaves after seventy seconds if it is not destroyed; destroyed, it is
  worth 40 credits. Hit points `300 × (1 + 0.45d)`. With a computer crew:
  a fresh ship rarely gets that far (~900 km); lasers at 2 meet it and
  watch it leave; lasers at 3 win about half the time with seconds to
  spare; a maxed ship wins in 30–65 s. It is the first goal the upgrades
  are for, and the gunner's big moment.
- **Solar flares**, every 35–60 s in space (sooner further out, never during
  a mothership): three seconds of warning from one side — a red edge, an
  arrow and a countdown on the TV, the matching button flashing on the
  shields phone, "tell shields" on everybody else's — then a 2.4 s burn
  that only the shield facing it stops. The computer shields officer gets
  there after 1.6 s.
- **Pickups**: green fuel, red repair, blue battery (full shield, cool
  lasers, cooler engines), pink gem (8 credits).
- **Death**: results screen with distance, cause, record, credits, and one
  line per station saying what that person did, a star on whoever "saved
  the ship" (`mvpOf`: a rough exchange rate between pickups, damage blocked,
  kills and boosts), and any paint job the run unlocked.

## Between runs

- **Hangar** (lobby and shop on one screen): QR, crew, the ship as it is now,
  the five upgrade tracks. Any phone buys; credits are shared.
- **Paint jobs** unlock at family-record milestones (500, 1000, 1500, 2500,
  4000 km), picked from any phone. Cosmetic only.
- **The save** (TV `localStorage`, `mctl_save`): credits, levels, record,
  launches, paint, motherships destroyed, planets visited.
- **First three launches**: the TV rotates a one-line tip per occupied
  station while the ship is in the atmosphere.

## Sound

**Turning it on.** A browser keeps a page silent until somebody touches
*that device* — the phones are other devices and do not count. Reported
from a tablet as "no sound at all". The TV now shows a yellow "tap this
screen (or press a key) for sound" pill until it has had a tap, click or
key, and that first tap only turns the sound on (it never launches:
`soundTap` remembers the sound was off when the touch began, because in
Chrome the context is already running by the time the launch handler
sees the same touch). iPads mute web audio with the ring/silent switch
unless the page says it plays media: `navigator.audioSession.type =
'playback'`, plus a one-sample buffer started inside the touch.

**Music: recorded instruments, rendered offline** (asked for: "the real
instruments like we have in the fishing game"). The same FluidR3 GM
recordings Dry Fly uses (Frank Wen, CC BY 3.0 — credited on the hangar
screen and in README). `python3 tools/samples.py` fetches them into
`tools/samples/` (git-ignored, ~40 MB); `python3 tools/music.py [name]`
renders every piece from the notes written out in that file, through a
hall reverb, into `web/music/*.mp3` and `music.json` (~5 MB in all).

- MP3, not Dry Fly's Opus: an iPad's Safari will not play Ogg.
- Loops are seamless by construction: the reverb tail past the last bar is
  folded onto the start, and the file carries 0.3 s of wrap either side, so
  `loopStart`/`loopEnd` sit inside periodic audio whatever a decoder does
  with the first few milliseconds of an MP3.
- The cymbal is FluidR3's reverse cymbal played forwards; the snare is
  synthesised and band-limited (white noise read as hiss).
- Held notes are carried past the 3 s recordings by crossfading repeats of
  their middle. The recordings' own vibrato swings their level about 3×;
  the looping adds nothing to that.

Pieces: three flight themes the family chooses between from any phone in
the hangar — **Liftoff** (heroic brass and a march snare, C major, 112
bpm, 69 s loop), **Starlight** (celesta, harp, flute, choir, D Lydian, 88
bpm, 66 s), **Hyperdrive** (driving strings, taiko, low brass, D minor,
132 bpm, 58 s) — or Off. Plus **hangar** (piano and strings, 51 s) and
**mothership** (the boss, E minor, 144 bpm, 40 s). Choosing a theme plays
it on the TV straight away so everyone hears it. Cues: `go` and
`liftoff-cue` at liftoff, `count`, `space` (the Karman line), `sector`,
`victory` (mothership down), `gameover` / `record` on the results,
`pickup` / `battery` / `gem`, `stage`, `alarm`.

**In the game** (`MUSIC`, `musicTick`, `cue`): files are fetched and
decoded only once the sound is on, one at a time, the hangar and the chosen
theme first. A cue not loaded yet falls back to the synthesised effect
(`sfx`). Music crossfades between hangar, theme and mothership, ducks to
35% under a long cue and to 30% while paused, and stops for the results.
Lasers, hits, explosions, the engine rumble (follows the throttle, roars on
a boost, stops on a stall, thins in vacuum), wind and thunder stay
synthesised.

## Tuning (as of the first build)

`node simcheck.mjs` prints these; they are also its pass bounds.

- Fresh ship, computer crew: ~800 km mean, ~3 minutes, ~170 credits.
- Fully upgraded, computer crew: ~1900 km, with the first mothership down.
- Upgrade costs `COSTS = [80, 180, 340, 560, 850]` per level, five levels
  each across five tracks: about 10,000 credits to max everything, so
  roughly 25–50 runs. Credits are `km/10 + half the kill bounty + 8 per gem`.

People will do better and worse than the computer; these numbers are a
starting point to retune after a family playtest, not a finished balance.

## The phone ↔ TV protocol (`PROTO` 1)

Phone → TV: `hello {name, dev, proto}`, `in {px | thr | ga, gf}` (the
station's continuous controls, sent the moment they change and re-sent
every 150 ms), `act {a: side | boost | pip}`, `pick {st}`, `buy {key}`,
`paint {key}`, `pause {v}`, `ready {v}`, `ping` (a seatless phone, once a
second).

TV → phone: `host {proto, min}`, `you {st}`, `s {...}` (the ship's state,
ten times a second, including `flare`, `boss`, `paused`, `paint`), `fx {k:
hit | block | stall | gunhot | dead | flare | boss | win}` for vibration.

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

- **The relay is built but off.** `worker.js` serves `/relay` (Family
  Beatdown's `relayPass`, ported); `net.js` asks it, keeps the pass in
  `mctl_relay` and never waits more than 2.5 s for it. It needs the two
  TURN secrets set on the Worker (`TURN_KEY_ID`, `TURN_KEY_API_TOKEN` — the
  same TURN key Family Beatdown uses will do). Until then a guest network,
  a router that keeps devices apart, or a phone on mobile data cannot
  join. Open `/relay` in a browser to see what a phone is given; `why`
  says what is wrong when it is null.
- **No licence gate.** It needs a Polar product (and its licence-key
  benefit id) to exist first; then port Family Beatdown's gate from its
  `worker.js` and `gatecheck.mjs`. Until then the game is free to whoever
  has the URL.
- **No trailer.** Family Beatdown's `VIDEO.md` approach would carry over.
- **Not tried on a real phone, TV or Fire Stick.** Everything is verified
  headless only. The first family playtest is the real test of whether
  each station is fun to hold.
- **Sound is on the TV only and needs one tap on the TV first** (browser
  rules; the TV says so). Phones only vibrate.
- **Events from between ticks used to vanish.** A shield turn or a boost
  sent by a phone emitted its event, and the next tick wiped `S.events`
  before the TV read it, so those never made a sound. `emit` now queues
  anything raised outside a tick (`S.queued`) into the next one.
- **Open question from the plan:** if Thrusters turns out to be the boring
  seat in playtesting, the fallback is an Engineer station (repairs, fires,
  rerouting power).
