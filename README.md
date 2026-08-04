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
| `pnpm -r test` | Run the test suite |
| `pnpm -r typecheck` | Type-check every package |
| `pnpm run build` | Production build |
