# cswap-usage

A [Paseo](https://paseo.sh) workspace panel that shows Claude usage for every
[claude-swap](https://pypi.org/project/claude-swap/) account on one line each.

![The panel showing three accounts, one line each](docs/screenshot.png)

## Why

Paseo's usage panel matches provider IDs exactly, so providers that use
`extends: "claude"` get no usage row at all. The single built-in `claude` row reads one
credential file, so it can only ever show whichever account is live right now. If you
juggle several Claude accounts through claude-swap, there is no way to see them together.

This panel fills that gap until Paseo inherits usage for extended providers.

## Requirements

- Paseo 0.7.2 or newer
- Plugins enabled on the target daemon (**Settings → Plugins → Enable plugins**)
- [`claude-swap`](https://pypi.org/project/claude-swap/) installed, with `cswap list --json` working

## Install

```bash
paseo plugin add creatorKoo/paseo-cswap-usage
```

Or from a local checkout:

```bash
git clone https://github.com/creatorKoo/paseo-cswap-usage
paseo plugin install "$PWD/paseo-cswap-usage"
paseo plugin ls          # expect: cswap-usage  running
```

## Usage

Open it with **⌘K** (**Ctrl+K** on Windows and Linux) → **Open cswap usage**, or from the
New tab menu under *plugin panels*. It is an ordinary workspace panel, so *Split down*
works — park it under your agent as a status strip.

Each account is one wrapping line:

```
skt  you@example.com  [active]   $ ▮▮▯▯ 35% $22.50/$65.00   5h ▮▮▮▮ 100% 16m   7d ▮▯▯▯ 14% 21h 36m · est. 16%   Fable ▮▯▯▯ 19% 21h 36m
```

- **alias**, **email**, and an `active` badge for the account claude-swap is currently on
- a chip per window: `$` spend (only on accounts that have it), `5h`, `7d`, then each
  scoped window such as `Fable`
- every chip is `label · mini bar · percent · countdown`, and wrapping happens between
  chips so a chip is never split across lines
- bar color goes accent → warning at 50% → danger at 90%
- **A−** / **A+** in the footer cycle three text sizes (S/M/L). It starts at S every time
  the panel opens; plugins have no storage API.
- **Refresh** just refetches. Within the 60s cache window you get the cached value back.

`est. N%` is a **linear** projection: `pct / expectedPct`, extrapolating the current burn
rate to the end of the window. It reads `will run out` once that crosses 100%. Treat it as
a rough signal — bursty usage skews it badly, which is why claude-swap leaves this estimate
out of its own human-facing output. It is blank for roughly the first 24 hours after a
reset, because claude-swap does not publish `expectedPct` until the window has run a while.

UI strings follow the system locale (Korean or English).

If an account is not healthy, its usage chips are replaced by claude-swap's status string
(`re-login needed`, `token expired`, `keychain unavailable`, and so on) in warning color.
That state is recomputed on every pass and never written to disk, which is the whole reason
this plugin shells out instead of reading claude-swap's cache file.

## How it works

`cswap list --json` is the only data source. The plugin never reads claude-swap's state
files, never calls the Anthropic API directly, and never runs a claude-swap command that
changes state — no `switch`, no `auto`. It is strictly read-only.

The daemon-side handler:

- caches for **60 seconds** and polls no faster, because the usage endpoint has a budget of
  roughly 28–30 requests per hour per identity, shared across every claude-swap surface.
  Whether a poll actually hits the network is claude-swap's decision, not ours.
- is **single-flight**: concurrent calls share one subprocess, never two.
- is **stale-on-error**: a failed call keeps the previous snapshot and only sets an error
  line, matching claude-swap's own behavior.
- never logs the subprocess stdout, which carries emails and organization names.

Fields the panel does not render (`organizationName`, `organizationUuid`,
`projectedExhaustionAt`, …) are dropped by the Zod schema on the daemon side, so they never
reach the client at all.

## Configuration

`cswap` is looked up at `~/.local/bin/cswap`. The daemon's `PATH` is not your shell's, so
the name is never resolved through `PATH`. Point `CSWAP_BIN` at an absolute path to
override it:

```bash
CSWAP_BIN=/opt/homebrew/bin/cswap
```

## Uninstall

```bash
paseo plugin remove cswap-usage
```

That removes the configuration only; it never deletes the source directory.

## Development notes

Notes on the Paseo 0.7.2 plugin compiler that are easy to get wrong:

- The entry point is `index.ts`. Paseo builds a **client and a server bundle from the same
  entry**, then strips `plugin.handle(...)` from the client and the UI registrations from
  the server — but only when they are bare statements in the contribute body.
- Node imports must use the `node:` prefix. The client bundle stubs `/^node:/` to `{}`;
  bare `"child_process"` is not stubbed and fails to resolve.
- Because those stubs are empty objects, **never call a Node API at module scope** — the
  panel would throw on load. `homedir()` and `promisify()` are called inside the handler.
- `*.client.tsx` and `*.server.ts` are pruned from the opposite bundle; unsuffixed modules
  such as `contract.ts` go into both, so keep them free of Node and React Native code.
- Every `Text` needs a color from `theme.colors`; unstyled text is black and invisible in
  dark themes.

Run `npm install` once, then `npm run typecheck` and `paseo plugin reload cswap-usage`
after any source change. Do not restart the daemon — it kills running agents.

## Status

Temporary. Delete this plugin once Paseo inherits usage for providers that use `extends`.

## License

MIT — see [LICENSE](LICENSE).
