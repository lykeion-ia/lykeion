# Lykeion

A dark, dense, keyboard-first research workbench. Runs entirely in the browser.

## Requirements

- Node ≥22
- pnpm 10.27

## Getting started

```bash
pnpm install
pnpm --filter @lykeion/ui dev
```

Then open http://localhost:1420. The app boots with populated data so every
screen has something to show; append `?seed=empty` to start from the blank
first-install state. The seed is read from the query string, so it has to sit
before the `#` — `http://localhost:1420/?seed=empty` — since routes live in the
hash, and adding it once a route hash is present lands it inside the fragment
where it is ignored.

State is held in memory for the session — a reload starts over.

## Layout

- `packages/api` — the typed data contract the UI programs against, plus a
  deterministic in-memory implementation of it. The contract carries lab
  members alongside studies, tasks, and sessions; `@lykeion/api/conformance`
  holds the suite any implementation of the contract is checked against.
- `packages/ui` — the application: React 19, Vite 7, Tailwind 4.

## Commands

| Command | Does |
| --- | --- |
| `pnpm test` | Run the test suite |
| `pnpm -r typecheck` | Type-check every package |
| `pnpm run build` | Production build |

`pnpm test` runs the packages one at a time, and that is deliberate: use it
rather than `pnpm -r test`. Each package's vitest already sizes its own worker
pool to every core, so running four of them at once oversubscribes the machine
about fourfold, and tests that assert against a clock — a teardown budget, a
render that has to settle, an expiry — start losing to the scheduler rather
than to any change in the code. Measured on an 8-core machine, `pnpm -r test`
failed two runs in three, on tests that pass every time their own package runs
alone; one package at a time passed three in three and cost about 13s.

## License

Copyright © 2026 Domenico Diego Marono.

Lykeion is free software under the [GNU Affero General Public License, version
3](LICENSE). You may run it, read it, change it, and pass it on. What the
licence asks in return is that those freedoms travel with the code: if you
distribute a modified Lykeion — or run one where other people can reach it over
a network — its users have to be able to get the source of the version they are
using.

That covers everyone who wants to run Lykeion for their own lab. If you want to
build on it under terms the AGPL does not grant, a separate commercial licence
is available: <diegomarono13@gmail.com>.
