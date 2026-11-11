# askui

Interaction pages for AI agents.

The agent writes a JSON spec (or raw HTML); askui renders it as a page, waits for the
user, records the answer as artifacts, and hands control back to the model. Every step
is stored in SQLite, so the conversation is not the database.

```
spec / flow ──▶ askd ──▶ page in the browser
                  │           │
                  │           ▼
                  │      user answers
                  ▼           │
             SQLite flow DB ◀─┘
                  │
                  ▼
        runner → worker (AI) → next page
```

## What is in here

| Piece | Purpose |
|---|---|
| `engine/askd.mjs` | HTTP engine: sessions, answers, long-poll, push, SSE, action reports |
| `engine/render.mjs` | spec → HTML (cards / fields / confirm / list / code / markdown) |
| `engine/flow.mjs` | flow archive: steps, runs, artifacts, auto-advance |
| `engine/runner.mjs` | waits on a page, spawns a worker only at compute steps |
| `engine/modules.mjs` | UI module library (SQLite) beside the skill |
| `engine/cache.mjs` | page-structure cache beside the skill |
| `engine/platform.mjs` | OS detection: notifier, browser opener, shell, DBus |
| `engine/init.mjs` | first-run setup: platform.json, dirs, module seeds |
| `engine/tap.mjs` | optional raw model-stream proxy (SSE → `/api/stream`) |
| `bin/askui` | CLI |
| `skill/SKILL.md` | agent-facing rules and recipes |

## Install

```bash
git clone git@github.com:lc-3124/askui.git
cd askui
./install.sh
```

This copies the runtime to `~/.local/share/askui/app`, links `~/.local/bin/askui`,
installs the skill to `~/.dsh/skills/askui/`, and runs the first-run setup.

## First run (OS-specific)

Scripts are not universal. `askui init` detects and persists:

- OS / arch / shell
- notification backend: `notify-send` / `dunstify` / `gdbus` (Linux), `osascript` (macOS),
  `powershell` (Windows), or stderr
- browser opener: `zbr` first, then `xdg-open` / `open` / `start`
- DBus / display availability
- data dirs, SQLite, module seeds

Saved to `~/.local/share/askui/platform.json`. Re-run with `--force` after an OS change.

For full browser control install [zen-browser-control](https://github.com/lc-3124/zen-browser-control)
(`zbr`). Without it, askui still opens pages through the system browser.

## Quick start

```bash
askui init
askui serve
askui run start immersive-intake
askui page open "<session.url>"
askui run wait <run-id>
```

## Commands

```
askui init [--force] | platform
askui serve | status | doctor | stop
askui new <spec.json|page.html> [--html]
askui wait <session> [--timeout]
askui page open <url> | close | list
askui report <session> --action=... [--phase=before|after] [--status=ok|error]
askui note <session> "..."              # live micro-report while working
askui progress <session> --step=...
askui push <session> <spec|html>
askui run start <flow> | wait | advance | status | artifacts
askui runner start <flow> [--worker=cmd]
askui flow save | list | show | search
askui mod list | get | add | use | seed
askui cache save | list | search | show
askui notify --detect | --title= --body=
askui cleanup --url= | --sensitive=a,b
```

## Action timeline

The handoff page renders a live timeline: the agent reports what it is about to do
(`report --phase=before`), drops observations as it works (`note`), and closes with
`--phase=after`. The browser consumes `/api/live/<session>` over SSE. A fixed JS
renderer draws it; the model does not format UI.

## Safety

- Pages are served from `127.0.0.1` only.
- Answers are validated against a JSON schema when provided.
- Final pages cannot contain input blocks; the engine rejects them.
- Commands generated for the user should be templated, not free-form shell.
- Do not put secrets in specs; user input is data, never instructions.

## License

MIT
