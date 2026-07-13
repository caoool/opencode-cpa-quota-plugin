# OpenCode CPA Quota Plugin

An OpenCode TUI sidebar plugin that displays subscription quota usage for Codex, Claude, and Grok accounts routed through [CLI Proxy API](https://github.com/router-for-me/CLIProxyAPI).

## Features

- Shows Codex, Claude, and Grok quotas simultaneously.
- Displays utilization percentages and reset timestamps.
- Uses green, yellow, and red percentage thresholds.
- Supports plan labels returned by upstream APIs and optional configured fallbacks.
- Provides a clickable refresh control and `/quota` command.
- Uses a dedicated file-backed cache, cross-process request lease, and shared exponential backoff to avoid duplicate quota requests and rate limits.
- Schedules each automatic refresh from the most recent completed refresh, so `refreshMs` is not accidentally doubled.
- Restores the most recently persisted shared quota result when a process starts.
- Shows the latest check time while retaining visible warnings when cached provider data is used.
- Updates the already-mounted sidebar after timer-driven checks; reopening OpenCode is not required.
- Suppresses upstream polling in `opencode --auto` workers by default while still letting those processes follow shared cache updates.

## Requirements

- OpenCode 1.17.15 or newer with TUI plugin support.
- A CLI Proxy API management endpoint and management key.
- CPA auth files for the providers whose quotas you want to display.

## Install from npm

Add the package to `~/.config/opencode/tui.json`. OpenCode installs npm TUI plugins automatically:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "opencode-cpa-quota-plugin",
      {
        "baseURL": "https://your-cpa.example.com",
        "managementKey": "your-management-key",
        "refreshMs": 600000,
        "planLabels": {
          "claude": "Max"
        }
      }
    ]
  ]
}
```

## Install from GitHub

From your OpenCode configuration directory:

```sh
cd ~/.config/opencode
npm install github:caoool/opencode-cpa-quota-plugin#main
```

Register the installed package directory in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "./node_modules/opencode-cpa-quota-plugin",
      {
        "baseURL": "https://your-cpa.example.com",
        "managementKey": "your-management-key",
        "refreshMs": 600000,
        "planLabels": {
          "claude": "Max"
        }
      }
    ]
  ]
}
```

The directory entry is required for GitHub-only installation. A bare package spec asks OpenCode to download it from the npm registry instead.

`baseURL` and `managementKey` are read directly as literal strings from `tui.json`. Keep this local configuration file private because it contains your management credential.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseURL` | none | Literal CPA base URL without `/v1`. |
| `managementKey` | none | Literal CPA management key. |
| `refreshMs` | `600000` | Automatic refresh interval. Values below one minute are clamped. |
| `timeoutMs` | `20000` | Request timeout. |
| `backoffMs` | `300000` | Initial rate-limit backoff, doubled up to one hour. |
| `pollInAutoMode` | `false` | Allow `opencode --auto` workers to participate in upstream polling. Disabled workers still read the shared cache. |
| `planLabels` | `{}` | Fallback labels keyed by `codex`, `claude`, or `grok`. Fetched labels take priority. |

Automatic upstream polling is disabled in `opencode --auto` workers by default. Set `pollInAutoMode` to `true` to let those workers contend for the same cross-process lease as interactive processes. Processes with polling disabled still read the shared file periodically, so an already-mounted sidebar adopts results written elsewhere. Values below one minute are clamped to one minute.

## Shared cache, lease, and privacy

Version 0.2.4 stores shared state beneath OpenCode's `api.state.path.state` directory:

```text
<stateDir>/cpa-quota-sidebar/cache.v1.json
<stateDir>/cpa-quota-sidebar/refresh.v1.lock/
```

The cache is written through a synced `0600` temp file and atomic rename. Refresh ownership uses an atomic `0700` lock directory with a `0600` owner marker; stale or incomplete locks are recovered without recursive deletion. A corrupt, oversized, or wrong-schema cache is replaced with the latest normalized safe state only after a process acquires that lease and before it makes any upstream request. File modes are applied where the operating system supports them.

The cache contains only normalized sidebar reports (including the displayed account labels), update/check timestamps, retry timing, the shared failure count, and an optional bounded error message from the latest total refresh failure. It does not store `baseURL`, `managementKey`, provider tokens, auth indexes, or credential payloads. The first 0.2.4 process migrates display cache fields from the legacy `cpa-quota-sidebar.cache.v2` OpenCode KV entry when no dedicated cache file exists. Legacy lease fields are ignored, and the old KV entry is neither rewritten nor deleted. If the dedicated file later disappears, the process rewrites its latest normalized shared/display state rather than replaying the process-start legacy snapshot.

**Upgrade requirement:** quit and restart every OpenCode process after installing 0.2.4. A still-running 0.2.3 process does not understand the shared file lease and can continue issuing duplicate requests until it exits.

## Usage

- Click the refresh icon in the **Quota** title row.
- Run `/quota` or `/quota-refresh`.
- Successful results are shared across concurrent OpenCode processes and cached across restarts.

## Development

```sh
npm install
npm run check
```

The package exposes its TUI entry through `exports["./tui"]`.

## Publishing

The repository includes `.github/workflows/publish.yml` for npm trusted publishing with GitHub Actions OIDC and provenance. On each push to `main`, the publishing workflow runs the package checks, compares the version in `package.json` with npm, and publishes only when that exact version does not already exist. Manual runs are restricted to `main`, and no npm token is stored in GitHub.
