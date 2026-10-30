# Mission Control

## Git workflow

Solo project, no collaborators — work directly on `main`. Commit and push
straight to `main`, no feature branches or PRs needed. Cloudflare Workers
deploys from `main` on every push, so anything on another branch is not
live, and a change has to work before it is committed.

## Start here

Read `HANDOFF.md` before making any non-trivial change — how the game is
put together, the phone protocol, the tuning numbers and what is not built
yet.

## The game lives in `web/`

`web/` is the only directory Cloudflare uploads. The check scripts and the
notes beside it stay in the repo and off the internet. Run the checks from
the repo root.

## Before shipping

```
node simcheck.mjs    # the simulation, headless: tuning, mothership, flares, shields, power, seats, shop
node netcheck.mjs    # the TV and five phones in Chromium, over ?local=1
node tools/art.mjs   # redraw the icons and link preview after changing how the ship looks
```

`web/sim.js` decides everything that happens and draws nothing. Change the
difficulty there and `simcheck` says whether a fresh ship still lasts a
sensible time and whether upgrades are still worth buying.
