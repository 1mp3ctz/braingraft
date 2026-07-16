<div align="center">

# 🧠 Claudeport

**Your Claude Code brain, on every machine.**

Diagnose what's silently broken, pack it, graft it — safely, reversibly, with zero dependencies.

[![CI](https://github.com/1mp3ctz/claudeport/actions/workflows/ci.yml/badge.svg)](https://github.com/1mp3ctz/claudeport/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-94%20passing-brightgreen)](test/)
[![dependencies](https://img.shields.io/badge/dependencies-0-blue)](package.json)
[![node](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

<a href="https://1mp3ctz.github.io/claudeport/">Landing page</a> ·
<a href="#the-problem-nobody-tells-you-about">The bug</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="SECURITY.md">Threat model</a>

</div>

```bash
npx github:1mp3ctz/claudeport doctor
```

> Not affiliated with Anthropic. "Claude" is a trademark of Anthropic, PBC. Claudeport is a compatible third-party tool that reads and writes your local Claude Code configuration.

---

## The problem nobody tells you about

Claude Code stores your auto-memory under `~/.claude/projects/<encoded-home-path>/memory/`, where the directory name is your machine's home path with the separators turned into dashes:

| Machine | Directory Claude reads |
|---|---|
| macOS, user `alice` | `~/.claude/projects/-Users-alice/memory/` |
| Windows, user `bob` | `~/.claude/projects/C--Users-bob/memory/` |
| Linux, user `dev` | `~/.claude/projects/-home-dev/memory/` |

Copy `~/.claude` to a new machine — with rsync, a dotfiles repo, chezmoi, or a USB stick — and your memory folder arrives under the **old** machine's name. Claude looks for the **new** one, finds nothing, and starts from zero. It doesn't warn you. It doesn't error. Everything you taught it is sitting right there on disk, invisible.

This is tracked upstream as [anthropics/claude-code#25739](https://github.com/anthropics/claude-code/issues/25739) — open and unfixed. Every "just sync your config" approach copies files and inherits the bug.

**`claudeport doctor` is the one command that tells you whether it's happening to you.** It's read-only. It can't break anything.

```
Memory
──────────────
  ✗  -Users-alice   macOS    14 files  61 KB   INVISIBLE — Claude cannot see this
  ✓  C--Users-bob  windows   2 files   4 KB   ACTIVE — Claude reads this

  61 KB of memory (14 files) is on this disk but invisible to Claude.
  → Fix it: claudeport pack on the source machine, claudeport graft here.
```

## How it works

Three commands get you the whole way. Only one of them ever writes.

```bash
claudeport doctor            # read-only diagnosis — start here
claudeport pack              # → claude-brain.brain  (portable, sanitized)
claudeport graft brain.brain # dry-run plan; add --apply to install it here
```

- **`doctor`** classifies every path in `~/.claude` (brain / memory / local / secret / unknown), sizes it, finds orphaned memory namespaces, flags secrets, and reports paths that won't survive a move. It never writes.
- **`pack`** builds a portable bundle: an allowlist of the things you actually authored (`CLAUDE.md`, `skills/`, `agents/`, `commands/`, `rules/`, `hooks/`, and a sanitized `settings.json`), plus your memory lifted into a machine-independent namespace. Absolute home paths become a portable token. Every file is hashed. It refuses to run if it finds a secret.
- **`graft`** re-materializes the bundle for *this* machine: memory lands in the namespace Claude actually reads here, the home token is rewritten to your real path, and `settings.json` is merged key-by-key so your local model/theme/keys are never touched. It's a dry run by default; `--apply` stages the writes, journals them, and lets you `claudeport undo` back to exactly where you were.

Keeping several machines in sync over time:

```bash
claudeport sync push --remote git@github.com:you/your-brain.git   # refuses a PUBLIC repo
claudeport sync pull                                              # three-way, same sanitizer
```

## What it never touches

- **Credentials.** `.credentials.json`, `.claude.json`, `.env` files, private keys — classified as secrets and **unpackable**. There is no flag to override this.
- **Your conversations.** Transcripts (`history.jsonl`, `projects/**/*.jsonl`) never leave the machine.
- **Your machine's identity.** `model`, `theme`, `tui`, `statusLine`, `effortLevel` and other machine-local settings stay put on both ends.
- **The network.** Zero telemetry, zero accounts, zero analytics. It never phones home. ([Read the source](src/) — it's a few hundred lines of plain ESM with no dependencies.)

## Safe by construction

A bundle you receive is, by design, code someone else's Claude will run (hooks) and instructions it will follow (skills, `CLAUDE.md`). Claudeport treats every bundle as untrusted input:

- **Dry run by default.** `graft` shows a per-file plan and writes nothing until you pass `--apply`.
- **Reversible.** Every apply is staged, journaled, and snapshotted. `claudeport undo` restores the machine byte-for-byte.
- **Consent from bytes, not claims.** `inspect` and `graft` compute what a bundle will do from its actual contents, never from its manifest's self-description. A bundle that carries executables or instruction files cannot be applied without `--trust`, and the files are listed for you first.
- **MCP servers and plugins are quarantined.** They are never auto-enabled; they land in `.claudeport/pending-mcp.json` with the commands printed, for you to add by hand.
- **Hardened extraction.** Path traversal, absolute paths, symlink/device entries, decompression bombs, Windows-reserved names, and case-collisions are all rejected before a single byte is written.
- **Optional encryption.** `pack --encrypt` seals the bundle with AES-256-GCM (scrypt-derived key) for transport on a USB stick.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Install

```bash
npx github:1mp3ctz/claudeport <command>   # no install — runs straight from this repo
```

Or clone it and run `node bin/claudeport.mjs <command>` — there is no build step and nothing to install.

Requires Node 18.17+. Works identically on Windows, macOS, and Linux.

> **Heads-up:** the `claudeport` name on npm belongs to a different, unrelated project. `npx claudeport` runs *their* code, not this one — always use the `github:` form above.

## Commands

| Command | Writes? | Does |
|---|---|---|
| `doctor` | no | Diagnose this machine. Start here. |
| `pack [-o file] [--encrypt] [--no-memory]` | no | Build a portable bundle. |
| `inspect <file>` | no | Show exactly what a bundle would do. |
| `graft <file> [--apply] [--theirs] [--trust]` | with `--apply` | Install a bundle. Dry run by default. |
| `undo` | yes | Roll back the last graft. |
| `sync push \| pull [--remote url]` | push: remote | Git-backed sync with a private repo. |

Add `--json` to any command for machine-readable output.

## Weekly sync, hands-free

Claudeport does not write to your system scheduler. Wire it up yourself in one line:

```bash
# cron (macOS/Linux) — Sundays at 9am
0 9 * * 0  cd ~ && npx github:1mp3ctz/claudeport sync push >> ~/.claudeport/sync.log 2>&1
```

```powershell
# Windows Task Scheduler
schtasks /create /tn claudeport-sync /sc weekly /d SUN /st 09:00 /tr "npx github:1mp3ctz/claudeport sync push"
```

## Development

```bash
git clone https://github.com/1mp3ctz/claudeport
cd claudeport
npm test          # 94 tests, stdlib only, no install needed
```

No build step. No dependencies. `src/` is plain ES modules you can read in an afternoon.

## License

MIT © Viktor ([@1mp3ctz](https://github.com/1mp3ctz)). See [LICENSE](LICENSE).
