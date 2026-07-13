# OpenCode CPA Quota Plugin

An OpenCode TUI sidebar plugin that displays subscription quota usage for Codex, Claude, and Grok accounts routed through [CLI Proxy API](https://github.com/router-for-me/CLIProxyAPI).

## Features

- Shows Codex, Claude, and Grok quotas simultaneously.
- Displays utilization percentages and reset timestamps.
- Uses green, yellow, and red percentage thresholds.
- Supports plan labels returned by upstream APIs and optional configured fallbacks.
- Provides a clickable refresh control and `/quota` command.
- Uses persistent OpenCode KV caching, request leasing, and exponential backoff to avoid quota-endpoint rate limits.
- Suppresses background polling in `opencode --auto` workers while keeping cached UI available.

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
      "opencode-cpa-quota-plugin@0.2.0",
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
npm install github:caoool/opencode-cpa-quota-plugin#v0.2.0
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
| `refreshMs` | `600000` | Automatic refresh interval. Values below five minutes are clamped. |
| `timeoutMs` | `20000` | Request timeout. |
| `backoffMs` | `300000` | Initial rate-limit backoff, doubled up to one hour. |
| `planLabels` | `{}` | Fallback labels keyed by `codex`, `claude`, or `grok`. Fetched labels take priority. |

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
