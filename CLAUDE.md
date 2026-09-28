# CLAUDE.md — cswap-usage

A Paseo workspace panel that draws claude-swap account usage, one line per account, and a
composer pill on built-in claude agents that shows the active account and can switch it.

**[README.md](README.md) is the source of truth.** Read it first — especially
*How it works* and *Development notes*.

## Rules

- **Read-only, with one exception.** Data comes from `cswap list --json` and nothing else.
  Do not read claude-swap's state files and do not call the Anthropic API directly. The only
  state-changing command is `cswap switch <number> --json`, run only when the user presses a
  switch button in the pill popover, and only for an account number from the last list.
  Never run `auto`, a bare `switch`, or any other claude-swap command that changes state.
- **Polling is fixed at 60 seconds.** Never lower it. The usage endpoint budget is roughly
  28–30 requests per hour per identity, shared with every other claude-swap surface.
- Apply source changes with `paseo plugin reload cswap-usage`. **Never restart the daemon**
  — it kills running agents.
- Do not enable the global `pluginsEnabled` switch without the user's explicit permission.
  Plugins are trusted, unsandboxed code.
- Never log the `cswap` subprocess stdout, for `list` or `switch`. It carries emails and
  organization names; log only error types and messages built from our own text.
- Typecheck (`npm run typecheck`) before every reload or install.
- Commit straight to `main`.
