# pi-message-recall

`pi-message-recall` adds fast recall of previous **user-entered text messages** in Pi.

It is built for the common flow: open a picker, search your old prompts, drop one back into the editor, and keep editing from there.

## Features

- `Alt+R` shortcut by default
- `/recall` fallback command
- fills the editor without auto-sending
- restores the previous text draft on cancel
- searches prior user text across persisted Pi sessions
- includes the current live session state, not just old session files
- quick scope switching in the picker with `Tab`
- configurable default scope, picker layout, and shortcut via `/recall settings`
- progressive loading and paginated results for large histories

## Install

Install from npm

```bash
pi install npm:pi-message-recall
```

Install from git:

```bash
pi install git:github.com/ayagmar/pi-message-recall
```

Pin to a specific release tag:

```bash
pi install git:github.com/ayagmar/pi-message-recall@vX.Y.Z
```

Project-local install (writes to `.pi/settings.json`):

```bash
pi install -l npm:pi-message-recall
```

Install from a local checkout:

```bash
pi install /absolute/path/to/pi-message-recall
```

Then reload Pi:

```text
/reload
```

Or load the local repo during development:

```bash
pi -e ./src/index.ts
```

## Usage

Open recall from Pi with either:

- `Alt+R`
- `/recall`

You can also prefill the picker query:

```text
/recall loading spinner
```

### What happens

1. The picker opens.
2. Select a previous user message.
3. The selected text is copied into the Pi editor.
4. Nothing is sent automatically.

If you cancel the picker, the previous **text draft** is restored.

## Picker UX

The picker opens as a centered native Pi overlay with:

- a live search field
- scope chips for `Project`, `Repo`, and `All`
- a scrolling native selection list
- a preview pane for the currently selected prompt
- height-aware results and preview sections that expand to use taller, wider fullscreen overlays without resizing as you move around
- a smarter preview that claims extra height for longer selected prompts when it helps
- loading, empty, and error states inline in the dialog

Keyboard flow:

- empty query shows recent messages first
- typing filters recalled messages case-insensitively
- quoted phrases work, for example: `"key hints" picker`
- regex mode works with `re:<pattern>` or `re:/pattern/flags`
- `Tab` cycles scope
- `PgUp` / `PgDn` page through results
- `Enter` fills the editor
- `Esc` cancels

## Scopes

The picker supports:

- **Project** — the current Pi session bucket / current working directory sessions
- **Repo** — sessions whose Pi cwd lives under the current git root, when available
- **All** — all persisted sessions Pi can list, plus the current project bucket

If repo scope is not available in the current directory, the picker falls back cleanly to the configured default or `Project`.

## Settings

Open settings with:

```text
/recall settings
```

Current status is available with:

```text
/recall status
```

Settings are stored here:

```text
~/.pi/agent/extensions/pi-message-recall/settings.json
```

Today the settings are:

- default scope
- picker layout (`Compact`, `Balanced`, or `Wide`)
- shortcut enabled / disabled
- shortcut key

Shortcut changes are saved and then applied through a clean Pi reload.

### Shortcut behavior

- default shortcut: `Alt+R`
- `/recall` always remains available
- `/recall` remains available even if the shortcut is disabled, invalid, or Pi refuses it on reload

## Performance notes

The picker is intentionally conservative for large histories:

- scope loading is incremental
- results are paginated
- the picker only renders the current results page at a time
- the UI does not try to render giant result sets at once

## Limitations

- recall is **text-only** in v1
- old images and attachments are not recalled
- cancelling restores the previous **text** draft only; Pi does not expose public APIs for restoring attachments in the editor
- all-scope recall depends on Pi's public session listing APIs, so custom session storage setups may only be partially visible outside the current project bucket

## Development

```bash
pnpm install
pnpm run check
```

Release commands:

```bash
pnpm run release:patch
pnpm run release:minor
pnpm run release:major
pnpm run release:first
```

Load locally in Pi:

```bash
pi -e ./src/index.ts
```
