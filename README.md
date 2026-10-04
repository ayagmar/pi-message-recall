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

## Requirements

- Pi 1.0.1 or newer (`pi --version`). Older Pi releases are not supported.

## Install

Install from npm:

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

Project-local install (writes to `.pi/settings.json`; Pi only loads project-local packages once the project is trusted):

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

Update later with `pi update npm:pi-message-recall` (or `pi update --extensions`); a bare `pi update` only updates Pi itself.

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

1. The picker opens, prefilled with the current editor text unless `/recall` was given an explicit query.
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

- empty query shows recent unique messages first
- typing prefers direct text matches, then falls back to fuzzy subsequence matches for unquoted terms
- repeated prompts are deduped by exact prompt text
- quoted phrases work, for example: `"key hints" picker`
- regex mode works with `re:<pattern>` or `re:/pattern/flags`
- `↑` / `↓` move through results and stop at the ends
- `Tab` cycles scope
- `PgUp` / `PgDn` page through results without wrapping
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

(`~/.pi/agent` is Pi's agent directory; if you set `PI_CODING_AGENT_DIR`, the file lives under that directory instead.)

Today the settings are:

- default scope
- picker layout (`Compact`, `Balanced`, or `Wide`)
- shortcut enabled / disabled
- shortcut key

Shortcut changes are saved and then applied through a clean Pi reload.

### Shortcut behavior

- default shortcut: `Alt+R`
- a shortcut needs `Ctrl`, `Alt` or `Super` plus a letter, digit, `F1`–`F12` or a named key such as `PageUp` or `Insert` (`Super` combos need a terminal with the Kitty keyboard protocol)
- the shortcut picker refuses keys that Pi reserves for its own actions (for example `Ctrl+C`, `Ctrl+X`, `Ctrl+O` or `Alt+Enter`, including any remaps in your `keybindings.json`); a previously saved reserved key is flagged at startup and in `/recall status`
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
- the picker and the shortcut need Pi's interactive terminal UI; in RPC clients `/recall` explains this, and `/recall settings` asks for the shortcut key as text
- old images and attachments are not recalled
- cancelling restores the previous **text** draft only; Pi does not expose public APIs for restoring attachments in the editor
- all-scope recall depends on Pi's public session listing APIs, so custom session storage setups may only be partially visible outside the current project bucket

## Development

```bash
pnpm install
pnpm run check
```

Load locally in Pi:

```bash
pi -e ./src/index.ts
```

## Releasing

Releases are cut from GitHub Actions — never from a laptop.

1. Merge Conventional Commits (`feat:`, `fix:`, `feat!:` …) into `master`.
2. Run **Actions → Release → Run workflow** (or `gh workflow run release.yml -f increment=auto`).
   `auto` derives the bump from the commits; pick `patch`/`minor`/`major` to override. Tick `dry_run` to preview.
3. The workflow runs `pnpm run check`, then release-it bumps `package.json`, updates `CHANGELOG.md`,
   tags `vX.Y.Z`, pushes and creates the GitHub release, and finally `npm publish` publishes with
   provenance through npm trusted publishing (OIDC — no npm token stored in the repo).

Preview locally with `pnpm release:dry`.

The first publish of a new package cannot use trusted publishing yet (the package must exist on npm
first): run the workflow once with `bootstrap: true` and a short-lived, publish-only `NPM_TOKEN`
repository secret, then configure trusted publishing on npmjs.com (GitHub Actions · repo · workflow
`release.yml`) and delete the secret. If a run already tagged and created the GitHub release but
failed at `npm publish`, re-run it with `publish_only: true` (plus `bootstrap: true` for that first
publish) instead of cutting a new version.

With no release tag yet, `auto` treats the whole history as unreleased, so the `feat!` commit makes
the first release 1.0.0. Pick `minor` instead to start at 0.2.0.
