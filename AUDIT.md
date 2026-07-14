# Self-audit of Plan v1 (2026-07-14)

Three independent reviewers audited `PLAN.md` v1 before any code was written.

| Reviewer | Verdict |
|---|---|
| Architecture | **6/10** — right instincts, wrong center of gravity |
| Security / threat model | **4/10** — the two highest-risk surfaces (archive extraction, AEAD) were unspecified |
| Product / market | **3/10 odds of attention** — the category is a graveyard; the *finding* is the asset |

## What the audit changed

### 1. The product is a diagnosis, not a sync tool (market)
Six "sync your Claude config" Show HNs scored 1–3 points. `tawanorg/claude-sync` has 216★. `claude-code-config-sync` is on npm with 140 downloads/month. **Every verb in v1 already ships somewhere.** Shipping a seventh, better-engineered sync tool and expecting a different result is delusional.

What does *not* ship anywhere: a tool that tells you **your memory is silently not loading on this machine**. That's [anthropics/claude-code#25739](https://github.com/anthropics/claude-code/issues/25739) — open, unfixed, under-known. It is verifiably happening on the author's own machine.

→ **`doctor` is the headline, not a utility.** It is read-only, it can't destroy anything, and its output is the shareable artifact. `pack`/`graft`/`sync` are the fix you earn the right to offer *after* the diagnosis lands.

### 2. Renamed: Mindmeld → **Claudeport** (market)
Cisco MindMeld is a live trademark in the same goods class; npm's trademark policy lets them force a rename with one email — after launch, after the links point at it. And you can never outrank Cisco + Star Trek in search. `claudeport` is free on npm, carries the keyword people actually search, and says what it does. (Rename cost is one constant: `src/brand.mjs`.)

### 3. The walker must not follow symlinks — the memory dir *is* one (architecture)
`~/.claude/projects/C--Users-bob/memory` on this machine is a **junction** to `projects/-Users-alice/memory`. A naive `readdir` walk either misses it, follows it into a 169 MB repo (`skills/gstack` is also a symlink), or grafts it as a *real* directory — instantly forking the brain into two divergent copies. That is the exact failure the product exists to prevent.
→ `lstat` everything. Never dereference. Record links as links. Write *through* an existing link on graft, never replace it.

### 4. `settings.json` needs a per-key policy table, not "sanitize it" (architecture)
The live file proves the cost: on this **Windows** box, `settings.json` still carries `mcpServers.some-local-server.command = "/Volumes/External/somebot/venv/bin/python"` and a `sh -c` statusLine — a whole-file clobber bug, already in production. And `model`/`theme`/`tui`/`effortLevel` must never travel.
→ SHARED / LOCAL / REWRITE / REDACT / UNKNOWN policy per key. Hooks deep-merged and **deduped by hash(matcher+command)** — naive append silently double-executes every hook.

### 5. Graft is RCE by design (security)
A `.brain` writes hook scripts that Claude Code **executes**, skills/CLAUDE.md that **inject instructions into the model**, and `mcpServers` that **launch subprocesses**. Grafting a stranger's bundle is equivalent to running unreviewed code — and no scanner can distinguish malicious natural-language instructions from legitimate ones.
→ Mandatory: zip-slip rejection, absolute-path rejection, symlink/hardlink/device entries rejected on *extraction*, decompression bomb caps, manifest treated as advisory (consent UI computed from actual bytes), full disclosure of every executable + instruction file before apply, and **mcpServers/plugins never auto-merge into an executable position** — they land in a pending file with the commands printed.

### 6. Memory is the biggest leak, and no regex will catch it (security)
The `memory/` corpus is the differentiator *and* the exposure: it contains identity, health, finances, family. Entropy scanning will never flag "my knee has been acting up since March" as a secret.
→ Structural redaction (drop `env`/`headers`/`*token*` values wholesale) is the control that actually works; the regex scanner is a *warning* layer. Plus an explicit privacy gate that names the human-readable files leaving the machine, and a `--no-memory` flag.

### 7. Cut for v1
Encryption **kept** (memory-on-a-USB-stick is exactly the case that needs it) but pinned to a single-shot, capped, AAD-bound construction — no hand-rolled streaming AEAD. Cut: `mirror` mode, the interactive wizard, TypeScript (plain ESM, so "zero dependencies" is true end-to-end), the word "signed" (it's *hashed* — signing has no trust root, so don't claim it), and the cron installer (README gives the two-line cron/Task Scheduler snippet instead of shipping code that writes to your system scheduler).

## Ratings after revision
The revised plan is in `PLAN.md`. The engineering bar is unchanged; what moved is the *ordering*: the safe, read-only, shareable thing ships first and carries the launch, and every destructive path got a transaction, a journal, and an undo.
