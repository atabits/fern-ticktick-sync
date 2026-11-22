# Fern TickTick Sync

Official two-way **TickTick Open API v1** synchronization plugin for [Fern](https://github.com/atabits/fern) with zero-secret-exposure **OAuth 2.0** (`SecretsVault`).

## Features
- **OAuth 2.0 Loopback Login:** Click **Sign In with TickTick (OAuth)** inside Fern; tokens are exchanged by Fern's Rust host and stored encrypted in `SecretsVault` (`${secret:access_token}` / `${secret:refresh_token}` — never visible to plugin JS).
- **3-Way Sync Engine:** Canonical task fingerprinting prevents sync loops, echoes, and ping-pong overwrites.
- **Smart Initial Merge:** Matches existing lists by name and links matching `(title, dueDate)` tasks on first sync without creating duplicates.
- **Full Field Coverage:** Projects/lists, Inbox, titles, notes, due/start dates & times (timezone-safe all-day handling), priorities (`0/1/3/5`), tags, checklists (`items`), subtasks (`parentId`), reminders, and recurring rules (`RRULE`) with automatic recurring occurrence rebinding.
- **Vanished Task Detection:** Probes disappeared TickTick tasks via `GET /project/{pid}/task/{tid}` to distinguish completions (`status >= 1`) from deletions (`404`).
- **Configurable:** Two-way / Pull-only / Push-only, conflict policy (`Last-Write-Wins` / `Fern wins` / `TickTick wins`), per-list checkboxes, auto-sync interval, and live activity log.

## Setup (OAuth 2.0)
1. Open [TickTick Developer Portal](https://developer.ticktick.com/manage) and create an app.
2. Set **OAuth redirect URL** to `http://127.0.0.1:18481/callback`.
3. In Fern open **Settings → Plugins → TickTick Sync → Plugin Settings**, paste your **Client ID** and **Client Secret**, and save.
4. Click **Open** on the **TickTick Sync** card and click **Sign In with TickTick**.

## License
MIT
