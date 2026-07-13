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

## Install from GitHub

From your OpenCode configuration directory:

```sh
cd ~/.config/opencode
npm install github:caoool/opencode-cpa-quota-plugin#v0.1.0
```

Register the installed package directory in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "./node_modules/opencode-cpa-quota-plugin",
      {
        "managementKeyEnv": "CPA_MANAGEMENT_KEY",
        "refreshMs": 600000,
        "planLabels": {
          "claude": "Max"
        }
      }
    ]
  ]
}
```

The directory entry is required for GitHub-only installation. A bare `opencode-cpa-quota-plugin` spec asks OpenCode to download the package from the npm registry instead.

Then export the key before starting OpenCode:

```sh
export CPA_BASE_URL="<your-cpa-base-url>"
export CPA_MANAGEMENT_KEY="your-management-key"
opencode
```

You can alternatively set `managementKey` directly in the plugin options, but that stores the key as plaintext in `tui.json`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseURL` | none | CPA base URL without `/v1`. Required unless `CPA_BASE_URL` is set. |
| `managementKeyEnv` | `CPA_MANAGEMENT_KEY` | Environment variable containing the management key. |
| `managementKey` | none | Literal management key; environment variables are safer. |
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
