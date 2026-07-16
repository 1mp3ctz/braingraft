# Claudeport — Plan v2 (post-audit)

> **Your Claude Code brain, on every machine.**
> Diagnose what's broken. Pack it. Graft it. Never lose it.

Plan v1 was audited by three independent reviewers before a line of code was written; their verdicts (6/10 architecture, 4/10 security, 3/10 market odds) and everything they changed are recorded in [`AUDIT.md`](AUDIT.md). This is the revised plan.

---

## 0. The finding (this is the product)

Claude Code stores auto-memory under `~/.claude/projects/<encoded-absolute-path>/memory/`, where the directory name is the machine's home path with separators replaced by dashes:

| Machine | Directory |
|---|---|
| macOS, user `alice` | `~/.claude/projects/-Users-alice/memory/` |
| Windows, user `bob` | `~/.claude/projects/C--Users-bob/memory/` |
| Linux, user `dev`    | `~/.claude/projects/-home-dev/memory/` |

Copy `~/.claude` to a new machine — with rsync, a dotfiles repo, chezmoi, or a USB stick — and the memory folder arrives under the **old** machine's name. Claude looks for the **new** one, finds nothing, and starts from zero. It doesn't warn you. It doesn't error. Everything you taught it is sitting right there on disk, **invisible**.

Tracked upstream as [anthropics/claude-code#25739](https://github.com/anthropics/claude-code/issues/25739) — open, unfixed. Every "sync your Claude config" tool shipped so far copies files and inherits this bug.

**`claudeport doctor` is the only thing that tells you it's happening to you.** Read-only. Cannot break anything. It is the headline.

---

## 1. Principles (non-negotiable)

| # | Principle | Consequence |
|---|---|---|
| P1 | **Never destroy a brain.** | Writes are staged, journaled, reversible. `graft` is a dry-run unless `--apply`. `undo` restores byte-identically. Snapshot the *write-set*, never the 1.3 GB tree. |
| P2 | **Never leak a secret.** | Allowlist, not denylist. Structural redaction (not regex) is the control. Credentials are unpackable — no flag overrides it. A privacy gate names every human-readable file before it leaves the machine. |
| P3 | **A bundle is untrusted input.** | Grafting executes code by design. Extraction is hardened like a tar parser under attack; consent is computed from actual bytes, never from the manifest's claims. |
| P4 | **Portable by construction.** | Home paths → `${CLAUDEPORT_HOME}` on pack, re-materialized per target OS on graft. Memory namespaces re-encoded for the target machine. Symlinks recorded, never followed. |
| P5 | **Zero dependencies, zero telemetry, zero accounts.** | Node stdlib only (`zlib`, `crypto`, `fs`). Plain ESM — no build step, so "auditable in an afternoon" is literally true. Nothing phones home, ever. |

## 2. Command surface (v1)

| Command | Writes? | Does |
|---|---|---|
| `claudeport doctor` | **no** | The diagnosis. Orphaned memory namespaces, classification of every path (brain / local / secret / unknown), sizes, secret findings, non-portable absolute paths, symlinks. |
| `claudeport pack [-o brain.brain] [--encrypt] [--no-memory]` | no (source read-only) | Portable bundle: allowlisted, structurally redacted, path-tokenized, memory lifted to a logical namespace, per-entry sha256. Refuses on secret findings. |
| `claudeport inspect <file>` | no | Everything the bundle will do, computed **from the actual bytes**: entries, origin OS, executables, instruction files, mcpServers it wants, checksum, encryption state. |
| `claudeport graft <file> [--apply]` | only with `--apply` | Dry-run plan by default. Per-file verdict table. Staged writes + journal. `settings.json` merged by key policy. mcpServers/plugins never auto-enabled. |
| `claudeport undo` | yes | Reverts the last graft from the journal. |
| `claudeport sync push\|pull [--remote url]` | push: remote; pull: local | Git-backed ongoing sync over the same sanitizer. Hard-refuses a **public** remote. |

`--json` on every command. Exit codes: `0` ok, `1` error, `2` findings.

## 3. The four hard problems

1. **Memory namespace remap.** Memory is lifted out of `projects/<encoded>/` into a logical `memory/<scope>/` namespace at pack time and re-encoded with the *target* machine's home path at graft time. This is the fix for §0.
2. **Symlinks.** On the author's machine `projects/C--Users-bob/memory` is a *junction* to the Mac's dir, and `skills/gstack*` are symlinks into a 169 MB repo. `lstat` everything; never dereference; record `{type:"link", target}`. On graft, if the destination is a link, **write through it** — never replace it (replacing forks the brain into two divergent copies). Materializing a link on Windows falls back to a copy + loud warning on `EPERM`.
3. **`settings.json` merge.** Per-key policy — `SHARED` (hooks, permissions, enabledPlugins, disabledSkills) / `LOCAL` (model, theme, tui, statusLine, effortLevel — never travel) / `REWRITE` (mcp commands+args: home-relative → token; foreign-absolute → *report, don't ship*) / `REDACT` (env, headers → `${VAR}` + `.env.example`) / `UNKNOWN` (keep target's value, list in report). Hooks deep-merged and deduped by `hash(matcher+command)`; permissions and disabledSkills set-unioned. Written only if the merged object re-parses and the target's LOCAL keys are byte-identical to before.
4. **Untrusted bundles.** See §4.

## 4. Threat model → mandatory controls

Grafting writes hooks Claude Code **executes**, instruction files that **steer the model**, and mcpServers that **launch subprocesses**. A `.brain` from a stranger is unreviewed code. Blocking for v1:

- Extraction rejects: paths escaping the root (zip-slip, canonicalized), absolute paths (POSIX *and* Windows), `..` segments, symlink/hardlink/device/FIFO entry types, Windows-reserved names and chars, case-collisions — **validated across the whole entry set before byte one is written**.
- Decompression caps: max total bytes, max entries, max single entry — abort before writing (gzip bomb).
- The manifest is **advisory**. Consent output is computed from the actual extracted bytes.
- Every executable (`#!`, `.sh`, `.ps1`, `.cjs`, `.py`) and every instruction file (`CLAUDE.md`, `skills/**`, `agents/**`, `commands/**`) is **listed** before apply. A bundle whose origin fingerprint ≠ this machine requires an explicit `--trust`.
- `mcpServers` and plugins from a bundle **never** merge into an executable position. They land in `.claudeport/pending-mcp.json` with the exact commands printed for the user to run by hand.
- Pack: `lstat`-only walk (a symlink to `/etc/passwd` must never have its *contents* embedded); URLs carrying embedded credentials (`https://ghp_x@github.com/...`) are blocked, not redacted.
- Crypto (`--encrypt`): AES-256-GCM, single-shot over the whole compressed archive (a 512 MB hard cap makes buffering safe and rules out a hand-rolled streaming AEAD). scrypt N=2^17, r=8, p=1, fresh 32-byte salt, fresh 12-byte nonce, both in the cleartext header. The header is bound into the **AAD**. Tag verified before a single byte is written. One generic `decryption failed` for wrong-passphrase / corruption / tampering (no oracle). No silent plaintext downgrade.
- `sync`: the remote's **actual visibility is queried before every push** (not once at init); a public repo is a hard refusal; the expected remote is pinned in local state so a silently repointed remote is refused too.
- The word "signed" appears nowhere. Entries are *hashed*. There is no trust root, so no signing claim.

## 5. Layout

```
bin/claudeport.mjs      arg parse, dispatch, exit codes
src/brand.mjs           product name in one place (rename = one constant)
src/env.mjs             home, claudeDir, platform, encodeProjectDir()
src/walk.mjs            lstat walk, link classify, cycle guard, size caps
src/classify.mjs        path → brain | local | secret | unknown  (allowlist first)
src/tar.mjs             minimal ustar reader/writer + hardened extraction validation
src/container.mjs       .brain container: magic, cleartext header (AAD), gzip, optional GCM
src/crypto.mjs          scrypt + AES-256-GCM
src/manifest.mjs        build / verify (recompute hashes from bytes)
src/rewrite.mjs         home ⇄ ${CLAUDEPORT_HOME}; EOL; exec-bit inference
src/memory.mjs          lift projects/<enc>/memory → memory/<scope>; land re-encoded
src/settings.mjs        KEY_POLICY table, deep merge, hook dedupe
src/scan.mjs            structural redaction (authoritative) + regex/entropy warnings
src/journal.mjs         stage → commit → journal → undo
src/{doctor,pack,inspect,graft,sync}.mjs
src/report.mjs, src/ui.mjs
test/*.test.mjs         node:test; golden fake-.claude fixtures (posix/win/junction/crlf/collision)
```

## 6. Testing

`node:test`, stdlib only. **The author's real `~/.claude` is never written to by any test** — fixtures build a fake tree in a temp dir and `CLAUDEPORT_HOME` points at it. Coverage targets the dangerous paths: extraction hardening (zip-slip, bombs, bad types), secret scanner (no false negatives on known prefixes), path rewriter (round-trip idempotence), memory remapper (mac↔win↔linux matrix), settings merge (LOCAL keys never move, hooks never duplicate), crypto (tamper → generic failure), graft (undo restores byte-identically). CI: ubuntu + macos + windows × node 20.

## 7. Launch

The post is not "I made a sync tool" (a category rejected six times on HN, receipts in `AUDIT.md`). The post is the finding:

> **Your Claude Code memory silently stops loading when you switch machines. Here's a read-only one-liner that shows whether it's happening to you.**

`npx claudeport doctor` → *"⚠ 61 KB of memory in a namespace Claude cannot see on this machine."* Cite #25739. Post to r/ClaudeAI first. The tool is the fix offered *after* the diagnosis lands.

## 8. Non-goals

No GUI. No cloud, no accounts, no telemetry. No syncing of conversation transcripts. No auto-installing plugins or MCP servers. No writing to your system scheduler (README gives the cron / Task Scheduler line; you run it).
