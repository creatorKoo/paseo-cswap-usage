# CLAUDE.md — cswap-usage

A Paseo workspace panel that draws claude-swap account usage, one line per account, and a
composer pill on claude agents: the active account on the built-in provider (with a switch
popover), or the pinned account on providers that run `cswap run <account>`. On a host
without cswap it shows the default Claude login as Paseo reads it.

**[README.md](README.md) is the source of truth.** Read it first — especially
*How it works* and *Development notes*.

## Rules

- **Read-only, with one exception.** Usage comes from `cswap list --json`. Do not read
  claude-swap's state files and do not call the Anthropic API directly. The only
  state-changing command is `cswap switch <number> --json`, run only when the user presses a
  switch button in the pill popover, and only for an account number from the last list.
  Never run `auto`, a bare `switch`, or any other claude-swap command that changes state.
- **One other usage source, for hosts without cswap.** Only when the `cswap` spawn fails
  with `ENOENT`, the list is Paseo's own reading of the default Claude login, from
  `paseo.providers.listUsage()` on the server. Any other cswap failure stays an error.
  Never read credentials for it, and never switch on it: its account numbers are negative
  so that none can pass for a cswap slot.
- Pinned providers come from Paseo's own config via `paseo.config.get()`, on the server
  only. Send the client nothing but the provider id and the `cswap run` account argument;
  provider entries can carry `env` with API keys.
- **Polling is fixed at 60 seconds.** Never lower it. The usage endpoint budget is roughly
  28–30 requests per hour per identity, shared with every other claude-swap surface.
- Apply source changes with `paseo plugin reload cswap-usage`. **Never restart the daemon**
  — it kills running agents.
- Do not enable the global `pluginsEnabled` switch without the user's explicit permission.
  Plugins are trusted, unsandboxed code.
- Never log the `cswap` subprocess stdout, for `list` or `switch`, nor Paseo's usage rows.
  They carry emails and organization names; log only error types and messages built from
  our own text.
- Typecheck (`npm run typecheck`) and test (`npm test`) before every reload or install.
  Tests must never spawn a real `cswap`; mock `node:child_process` as `server/cswap.test.ts`
  does.
- Commit straight to `main`.
