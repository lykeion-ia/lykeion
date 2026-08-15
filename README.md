# Lykeion

A dark, dense, keyboard-first research workbench, where coding agents do the
work and every run is confined.

## There is no cloud

Lykeion runs on your own computers and nowhere else. There is no account to
create with us, no service to sign up for, and nothing about your work leaves
the machines you put it on.

**A researcher working alone needs no server, no domain and no certificate.**
One command on one laptop gives you the whole product: the lab that holds your
Studies and Tasks, and the machine that runs the agents, both behind
`http://localhost:1421`. A *lab* is only Lykeion's word for the thing that
holds the work and the people — it is not a thing you have to go and deploy.

A group that wants to share one runs the same program on a server they control
and points their machines at it. That is the only difference, and it is a
difference between two of your own computers, not between free and hosted.

## Requirements

- Node ≥22
- pnpm 10.27
- macOS, for running agents. Lykeion will not start an agent it cannot confine,
  and the sandbox backend is macOS-only today. Everything else — holding
  Studies and Tasks, reading a Notebook, running a lab for other people's
  machines — works anywhere Node does.

## From nothing to a running agent

```bash
git clone <this repository> && cd lykeion
./scripts/install.sh
lykeion
```

That is the whole of it. `lykeion` starts the machine, brings up a lab beside
it if you say the lab lives here, and opens a browser on
`http://localhost:1421`. The first run asks three things: where the lab lives,
who you are, and which agents to sign in to — and the third is skippable.

Afterwards:

| Command | Does |
| --- | --- |
| `lykeion` | Start this machine and serve its address |
| `lykeion open` | Open this machine's page in a browser |
| `lykeion url` | Print a fresh link and nothing else, for a machine you reach over SSH |
| `lykeion status` | Ask a running daemon how it is doing. Safe to poll |
| `lykeion stop` | Ask it to stop, and wait until it has |
| `lykeion logs --tail` | Follow what it is doing |
| `lykeion pair --code <c>` | Finish joining a lab from a machine with no browser |

`lykeion --help` prints every flag.

### A machine with no browser

A cluster node reached over SSH has no browser and no route back to its own
loopback address, so the ordinary pairing link is no use on it. Start it with
`--no-browser` and it prints one line beginning `LYK1.`. Paste that into your
lab's `#/pair` page from any computer that does have a browser, approve it, and
bring the code it gives you back:

```bash
lykeion pair --code <code>
```

No tunnel, no port forwarding, no `ssh -L`.

## The UI on its own

```bash
pnpm install
pnpm --filter @lykeion/ui dev
```

Then open http://localhost:1420 — the application against an in-memory
implementation of its own contract, with no lab and no daemon. It boots with
populated data so every screen has something to show; append `?seed=empty` to
start from the blank first-install state. The seed is read from the query
string, so it has to sit before the `#` —
`http://localhost:1420/?seed=empty` — since routes live in the hash, and
adding it once a route hash is present lands it inside the fragment where it
is ignored.

State is held in memory for the session — a reload starts over.

## Layout

- `packages/api` — the typed data contract the UI programs against, plus a
  deterministic in-memory implementation of it. The contract carries lab
  members alongside studies, tasks, and sessions; `@lykeion/api/conformance`
  holds the suite any implementation of the contract is checked against.
- `packages/ui` — the application: React 19, Vite 7, Tailwind 4.
- `packages/server` — the lab: what holds Studies, Tasks, people and their
  history, over SQLite.
- `packages/daemon` — the machine: the per-computer process that pairs with a
  lab, reports what it can run, and confines every agent it starts.

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
