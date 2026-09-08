# CLAUDE.md — cswap-usage

A Paseo workspace panel that draws claude-swap account usage, one line per account.

**[README.md](README.md) is the source of truth.** Read it first — especially
*How it works* and *Development notes*.

## Rules

- **Read-only plugin.** Data comes from `cswap list --json` and nothing else. Do not read
  claude-swap's state files, do not call the Anthropic API directly, and do not run a
  claude-swap command that changes state (`switch`, `auto`, …).
- **Polling is fixed at 60 seconds.** Never lower it. The usage endpoint budget is roughly
  28–30 requests per hour per identity, shared with every other claude-swap surface.
- Apply source changes with `paseo plugin reload cswap-usage`. **Never restart the daemon**
  — it kills running agents.
- Do not enable the global `pluginsEnabled` switch without the user's explicit permission.
  Plugins are trusted, unsandboxed code.
- Never log the `cswap` subprocess stdout. It carries emails and organization names.
- Typecheck (`npm run typecheck`) before every reload or install.
- Commit straight to `main`.
