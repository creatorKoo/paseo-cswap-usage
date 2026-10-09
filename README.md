# cswap-usage

[한국어](README.ko.md)

A [Paseo](https://paseo.sh) workspace panel that shows Claude usage for every
[claude-swap](https://pypi.org/project/claude-swap/) account on one line each, plus a
composer pill that shows the active account's usage and switches accounts in two clicks.

<p>
  <img src="docs/pill-popover.png" width="360" alt="The pill's popover: every account on one line, switch buttons, and the label picker">
  <img src="docs/pill-tooltip.png" width="170" alt="The pill above the chat input, with its tooltip">
</p>

![The panel showing three accounts, one line each](docs/screenshot.png)

## Why

Paseo reads usage for the login it can see: the host's default one, or the config directory
a provider declares in its `env`. A provider that launches `cswap run <account>` picks its
account inside cswap's own process, so Paseo shows the default login's numbers for it, not
the account the agent runs on. If you juggle several Claude accounts through claude-swap,
there is no way to see them together.

This panel fills that gap.

## Requirements

- Paseo 0.11.0 or newer. v0.4.0 is the last release for Paseo 0.9.2 through 0.10.
- Plugins enabled on the target daemon (**Settings → Plugins → Enable plugins**)
- [`claude-swap`](https://pypi.org/project/claude-swap/) installed, with `cswap list --json`
  working. Without it the plugin shows the host's default Claude login instead; see
  [Without claude-swap](#without-claude-swap).

## Install

```bash
paseo plugin add git:creatorKoo/paseo-cswap-usage
```

The `git:` prefix is needed on Paseo 0.11 and later, where a bare `owner/name` is looked up
in the plugin registry instead of on GitHub. On Paseo 0.9.2 through 0.10, add
`--ref v0.4.0`.

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

Accounts are the rows of a table. A row never wraps, and the same chip always sits in the
same column:

```
skt   you@example.com [active]   5h    ▮▮▮▮ 100% 16m                  7d    ▮▯▯▯  14% 21h 36m · est. 16%   Fable ▮▯▯▯  19% 21h 36m              $     ▮▮▯▯  35% $22.50/$65.00
alt   me@example.com             5h    ▮▯▯▯  22% 3h 41m               7d    ▮▯▯▯   6% 4d 02h                                                    $     ▯▯▯▯   4% $2.40/$65.00
team  team@example.com           5h    ▮▮▯▯  48% 2h 05m               7d    ▮▮▯▯  51% 3d 11h · est. 74%    Fable ▮▮▮▯  63% 3d 11h
```

- **alias**, **email**, and an `active` badge for the account claude-swap is currently on
- a column per window: `5h`, `7d`, each scoped window such as `Fable`, then `$` spend last.
  A column exists only if at least one account has that window.
- every cell is `label · mini bar · percent · countdown`. Cells are fixed-width so the columns
  line up, an account without a window leaves that cell blank, and the table scrolls
  sideways when the pane is narrower than the table.
- bar color goes accent → warning at 50% → danger at 90%
- **A−** / **A+** in the footer cycle three text sizes (S/M/L). The choice is saved on the
  host, so the panel reopens at the same size; it starts at S.
- **Refresh** just refetches. Within the 60s cache window you get the cached value back.

`est. N%` is a **linear** projection: `pct / expectedPct`, extrapolating the current burn
rate to the end of the window. It reads `will run out` once that crosses 100%. Treat it as
a rough signal — bursty usage skews it badly, which is why claude-swap leaves this estimate
out of its own human-facing output. It is blank for roughly the first 24 hours after a
reset, because claude-swap does not publish `expectedPct` until the window has run a while.

UI strings follow the system locale (Korean or English). The screenshots show the Korean
locale; `예상` is `est.`

If an account is not healthy, its status (`token_expired`, `relogin_required`,
`keychain_unavailable`, and so on) is shown in warning color. When claude-swap still has a
last successful reading for that account, the chips are drawn dimmed from that reading, the
status becomes a badge beside the alias, and `last value HH:MM:SS` gives the time of that
reading. Without a last reading, the status string replaces the chips. That state is
recomputed on every pass and never written to disk, which is the whole reason this plugin
shells out instead of reading claude-swap's cache file.

`token_expired` is usually transient: it appears while a live `cswap run` session holds the
account's credential, because claude-swap leaves that token alone rather than log the session
out. The running Claude refreshes it on its next API call, so an idle session can sit in this
state for a while.

### Composer pill

Every agent on the built-in `claude` provider gets a pill above its chat input for the
account claude-swap is currently on (screenshots at the top):

- The icon's two bars are that account's 5h and 7d windows, in the panel's colors. They
  dim and get a warning outline when the account is not healthy.
- The label is the 5h percent and time to reset, then the alias. The alias comes last, so a
  long one is what gets cut to `…`. Hover for the full reading, one line each: the account,
  both windows with their resets, and any status.

Press the pill for a popover with every account on one line and a **Switch** button on each
inactive one. Switching runs `cswap switch <number>`, which switches the whole machine: every
running claude agent and terminal on the default login follows it (on macOS within about 30
seconds, once Claude Code's Keychain cache expires). **Open panel** opens the full table.

The popover's footer also picks the label, previewed with the account's own numbers:
`42% 2h31m` (default), `42% / 14%` (5h / 7d), or `42%`. The same choice is in
**Settings → Plugins → cswap usage**.

A provider that extends `claude` and launches `cswap run <account>` is pinned to that
account, so its agents get a **pinned** pill for that account instead of the active one:

```json
"claude-work": {
  "extends": "claude",
  "command": ["/Users/you/.local/bin/cswap", "run", "work", "--"]
}
```

A pinned pill reads the same way, its tooltip says `pinned` where the other says `active`,
and its popover has no switch buttons, because a switch never moves an agent that
`cswap run` pinned. The account can be a slot number, an alias, or an email, as `cswap run`
takes it. A `cswap run` with no account (the directory mapping) gets no pill.

### Without claude-swap

On a host where `cswap` is not installed, the panel and the pill show the host's default
Claude login instead: the one a plain `claude` runs on. The reading is Paseo's own, the same
one behind its Usage screen, so the plugin still reads no credentials and sends nothing to
Anthropic.

```
Claude  you@example.com [active]   5h    ▮▮▯▯  42% 2h 3m    7d    ▮▯▯▯  14% 3d 9h    Fable ▮▯▯▯  19% 3d 9h
```

- The row is named after Paseo's own label for the login, with its email when Paseo knows
  it. Paseo can list more than one Claude login; the first is the default one and gets the
  `active` badge and the pill.
- There are no switch buttons, no `est.` projection, and no `$` column. Those need
  claude-swap.
- Paseo refreshes its reading about every five minutes, so that is how fresh the numbers
  are. The footer shows when Paseo last read them.
- A login Paseo cannot read (an expired token, for example) shows Paseo's status and its
  reason, such as the command that refreshes it. No last reading is kept for it.
- A line under the row says where `cswap` was looked for. If it is installed somewhere else,
  set `CSWAP_BIN` (see [Configuration](#configuration)); a pill pinned by `cswap run` stays
  empty until then, rather than show the default login's numbers.

The plugin looks for `cswap` again on every poll, so the full table appears within a minute
of installing it, with no reload.

## How it works

`cswap list --json` is the only source of usage on a host that has claude-swap. The plugin
never reads claude-swap's state files and never calls the Anthropic API directly. It runs
exactly one command that changes state — `cswap switch <number> --json` — and only when you
press **Switch** in the pill popover. It never runs `auto` or a bare `switch`.

Only when `cswap` is not installed (the spawn fails with `ENOENT`) does it ask Paseo for the
usage Paseo already reads for the default Claude login (`paseo.providers.listUsage()`).
Paseo fetches and caches that for itself, so the plugin adds no request of its own to the
usage endpoint. Any other cswap failure is reported as an error, never papered over with the
default login.

To find pinned providers it reads Paseo's own provider config on the server
(`paseo.config.get()`). Only each provider's id and its `cswap run` account leave the
server; the rest of the entry, including any `env` with API keys, never does.

The server-side handler, which runs in the plugin subprocess the daemon starts:

- caches for **60 seconds** and polls no faster, because the usage endpoint has a budget of
  roughly 28–30 requests per hour per identity, shared across every claude-swap surface.
  Whether a poll actually hits the network is claude-swap's decision, not ours.
- is **single-flight**: concurrent calls share one subprocess, never two.
- is **stale-on-error**: a failed call keeps the previous snapshot and only sets an error
  line, matching claude-swap's own behavior.
- accepts a switch only for an account number from the last list, runs one switch at a
  time, and then marks the new active account in its cache rather than spawning another
  `cswap list`. The panel, every pill, and every popover share one query, so they add no
  polling of their own.
- never logs what either command prints, stdout or stderr, which can carry emails and
  organization names. A failure shows cswap's own message in the panel and logs only our
  description of it.

Fields the panel does not render (`organizationName`, `organizationUuid`,
`projectedExhaustionAt`, …) are dropped by the Zod schema on the server side, so they never
reach the client at all.

## Configuration

`cswap` is looked up at `~/.local/bin/cswap`. The daemon's `PATH` is not your shell's, so
the name is never resolved through `PATH`. Point `CSWAP_BIN` at an absolute path to
override it:

```bash
CSWAP_BIN=/opt/homebrew/bin/cswap
```

It has to be set in the environment of the **Paseo daemon process**, which is where the
handler runs. Exporting it in your shell does nothing for an already-running daemon — set
it where the daemon is started (on macOS, `launchctl setenv CSWAP_BIN <path>` before
relaunching the Paseo app, or in the shell that launches the daemon).

The plugin cannot tell a `cswap` installed somewhere else from one that is not installed.
In both cases it shows the default login, and the panel says which path it looked at.

## Uninstall

```bash
paseo plugin remove cswap-usage
```

`remove` deletes the plugin's configuration. It never deletes a directory source, so a
local checkout you installed with `paseo plugin install` stays where it is. For a Git
source installed with `paseo plugin add`, it also deletes the managed checkout.

## Development notes

```text
index.client.tsx              app bundle: panel, pills, settings screen, Command Center
index.server.ts               daemon bundle: RPC handlers and the settings documents
client/usage.tsx              the panel itself
client/pill.tsx               the pill's gauge icon, label, and popover
client/pill-registration.tsx  keeps one pill on every claude agent, active or pinned
client/settings.tsx           the pill label setting
client/common.ts              the usage query the panel and pills share
client/format.ts              pure labels, tooltips, and lookups (no React), tested
server/cswap.ts               spawning cswap, caching, parsing, switching
server/default-login.ts       Paseo's reading of the default login, for hosts without cswap
server/pinned.ts              finding `cswap run <account>` in provider commands
shared/contract.ts            the Zod RPC contracts, compiled into both bundles
shared/settings.ts            the settings documents: pill label, panel text size
*.test.ts                     vitest, next to the module each one covers
```

Notes on composer pills:

- Paseo draws the pill: one line, capped at 160px wide, in its own font and muted color. A
  plugin only supplies the label string and a 16×16 icon, so detail goes in the tooltip and
  the popover.
- The icon component owns the label. Only a component can subscribe to the usage query and
  the settings, so it pushes `{ label, title }` through the registration's `update` from an
  effect.
- On compact layouts the title doubles as the bottom sheet heading, so it stays short there.

Notes on the Paseo plugin compiler (0.8 and later) that are easy to get wrong:

- There are **two entry points**, `index.client.tsx` and `index.server.ts`, each with its
  own `contribute()` default export. A plugin needs at least one; this one has both.
- **Directories are the compiler boundary.** `client/` compiles into the app bundle only,
  `server/` into the daemon bundle only, `shared/` into both. Filename suffixes such as
  `*.client.tsx` mean nothing in 0.8, and any other code module left in the repository root
  is a compile error.
- A client import that reaches `server/`, a server import that reaches `client/`, and any
  `node:` import reachable from client code are all **compile errors** — not empty stubs, as
  in 0.7. So `server/` is a plain Node bundle: module-scope `promisify()` and `homedir()`
  are fine there.
- `shared/` carries Zod contracts and plain values only. It lands in the app bundle too, so
  it must stay free of Node and React Native code.
- Imports are split by runtime: `defineRpc` from `@getpaseo/plugin`, hooks and client
  contribution types from `@getpaseo/plugin/client`, `PluginServerContext` from
  `@getpaseo/plugin/server`.
- `paseo-plugin.json` must declare `requirements.paseo`. A manifest without it is read as
  `<0.8.0` and Paseo 0.8 refuses to load the plugin.
- Every `Text` needs a color from `theme.colors`; unstyled text is black and invisible in
  dark themes.

Run `npm install` once, then `npm run typecheck`, `npm test`, and
`paseo plugin reload cswap-usage` after any source change. Do not restart the daemon — it
kills running agents.

The tests never run a real `cswap`: `server/cswap.test.ts` mocks `execFile` and answers
each spawn itself, and every test checks that nothing from cswap's output reached the logs.
There is no vitest config file, since any code module in the repository root is a compile
error; the defaults find the tests.

## License

MIT — see [LICENSE](LICENSE).
