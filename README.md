# OpenCode CPA Quota Plugin

An OpenCode TUI sidebar plugin that displays subscription quota usage for Codex, Claude, and Grok accounts routed through [CLI Proxy API](https://github.com/router-for-me/CLIProxyAPI).

## Features

- Shows Codex, Claude, and Grok quotas simultaneously.
- Displays utilization percentages and reset timestamps.
- Uses green, yellow, and red percentage thresholds.
- Supports plan labels returned by upstream APIs and optional configured fallbacks.
- Provides a clickable refresh control and `/quota` command.
- Uses persistent OpenCode KV caching, request leasing, and exponential backoff to avoid quota-endpoint rate limits.
- Schedules each automatic refresh from the most recent completed refresh, so `refreshMs` is not accidentally doubled.
- Adopts newer shared-cache results written by another OpenCode process.
- Shows the latest check time while retaining visible warnings when cached provider data is used.
- Suppresses background polling in `opencode --auto` workers by default, with an opt-in override.

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
| `pollInAutoMode` | `false` | Allow `opencode --auto` workers to participate in automatic polling. Shared leases coalesce concurrent requests. |
| `planLabels` | `{}` | Fallback labels keyed by `codex`, `claude`, or `grok`. Fetched labels take priority. |

Automatic polling is disabled in `opencode --auto` workers by default to prevent duplicate upstream requests. Set `pollInAutoMode` to `true` to enable it; cross-process leases coalesce workers so normally only one performs each upstream refresh. Values below one minute are clamped to one minute.

## Usage

- Click the refresh icon in the **Quota** title row.
- Run `/quota` or `/quota-refresh`.
- Successful results are cached across OpenCode restarts.

## Development

```sh
npm install
npm run check
```

The package exposes its TUI entry through `exports["./tui"]`.

## Publishing

The repository includes `.github/workflows/publish.yml` for npm trusted publishing with GitHub Actions OIDC and provenance. On each push to `main`, the publishing workflow runs the package checks, compares the version in `package.json` with npm, and publishes only when that exact version does not already exist. Manual runs are restricted to `main`, and no npm token is stored in GitHub.
