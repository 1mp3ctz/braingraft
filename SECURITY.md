# Security & Threat Model

Braingraft moves your Claude Code configuration between machines. That makes it security-sensitive in two directions: what leaves your machine when you **pack**, and what runs on your machine when you **graft**. This document is the honest account of both.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/1mp3ctz/braingraft/security/advisories/new) on GitHub, or email the maintainer. Please do not open a public issue for a vulnerability until it has a fix.

## What a bundle is

A `.brain` bundle is a gzipped, ustar archive with a hashed manifest, optionally sealed with AES-256-GCM. It contains the things you authored (`CLAUDE.md`, `skills/`, `agents/`, `commands/`, `rules/`, `hooks/`, helpers, a sanitized `settings.json`) and your memory. It does **not** contain credentials, conversation transcripts, caches, or machine-local state.

## Direction 1 — packing: what leaves your machine

### Never packable (allowlist, no override)
Classification is an **allowlist**: only known-authored paths are eligible. Everything else is dropped. On top of that, these are hard-excluded as secrets with no flag to include them:

- `.credentials.json`, `*.credentials.json` (OAuth tokens)
- `.claude.json` (contains `userID`, `machineID`, per-project history)
- `.env` and `.env.*` files, `*.pem`, `*.key`, `id_rsa`/`id_ed25519`, `.netrc`
- `settings.local.json`

Conversation transcripts (`history.jsonl`, `projects/**/*.jsonl`) are classified machine-local and never leave.

### Structural redaction (the real control)
`settings.json` is sanitized by a per-key policy, not a regex:

- **Local keys never travel** — `model`, `theme`, `tui`, `statusLine`, `effortLevel`, notification flags, etc.
- **`env` and `headers` values are stripped wholesale** and replaced with `${VAR}` references, whatever they contain. A generated `env.example` lists the variable names so the recipient knows what to set.
- **`mcpServers`, `enabledPlugins`, `extraKnownMarketplaces` are quarantined** — carried for reference, never merged into an executable position on graft.
- **Credentials embedded in URLs** (`https://token@host/…`) are blocked, not redacted.

### Secret scanning (a second layer, not the first)
A scanner flags key-shaped secrets (Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe, GitLab, private-key blocks, secret-named assignments, secrets passed as CLI arguments) and **blocks the pack** when it finds one, with a precise `file:line`. This is a backstop; the structural redaction above is what actually protects you.

**Honest limitation:** a regex/entropy scanner cannot catch every secret. A high-entropy value with no recognizable name, a secret split across lines, or an encoded blob can slip past it. Store secrets in environment variables, not in your config files, and review `braingraft doctor` output before packing.

### Memory is prose about your life
Your memory files are the most sensitive thing in the bundle and no scanner can redact them — they are natural-language notes you wrote. `pack` prints the human-readable files that are about to leave your machine and asks for confirmation. Use `--no-memory` to pack configuration only.

### The `pack` process only reads
Packing never modifies the source directory. The directory walk uses `lstat` and never follows symlinks, so a symlink's target contents are never embedded — the link is recorded as a link.

## Direction 2 — grafting: what runs on your machine

**Grafting a bundle is equivalent to running unreviewed code.** It writes hook scripts Claude Code executes, skills and `CLAUDE.md` that steer the model on every prompt, and it can request MCP servers that launch subprocesses. No content scanner can distinguish a malicious natural-language instruction from a legitimate one. Treat a `.brain` from someone else exactly as you would treat running their shell script.

Braingraft's mitigations:

### Extraction is hardened
Before any byte is written, the entire entry set is validated. Rejected outright:
- paths that escape the destination root (zip-slip), canonicalized
- absolute paths (POSIX and Windows drive-letter forms)
- `..` traversal segments and backslash separators
- symlink, hardlink, device, and FIFO entry types (regular files and directories only)
- Windows-reserved names (`con`, `aux`, `nul`, `com1`…), illegal characters, trailing dot/space
- case-collisions that would clobber on NTFS/APFS

Decompression is capped by total bytes, entry count, and per-entry size to defeat compression bombs, and `gunzip` runs with a hard `maxOutputLength`.

### Consent is computed from bytes, never from the manifest
`inspect` and `graft` recompute every hash from the actual archive contents and report a mismatch or an unlisted file. A bundle cannot make the consent screen lie by editing its own manifest.

### The trust gate is not spoofable
A bundle that carries executables, instruction files, or MCP requests **cannot be applied without `--trust`**. This requirement is derived from the archive's real contents, not from a self-declared "origin" field a bundle author controls.

### `--trust-mine`: lifting the MCP quarantine for your own machines

Moving a brain between machines *you* own, the quarantine is friction — you wrote those MCP servers. `graft --trust-mine` enables the bundle's `mcpServers`, `enabledPlugins`, and `extraKnownMarketplaces` instead of parking them in `pending-mcp.json`.

Because enabling an MCP server means launching a subprocess, this flag demands **proof the bundle is actually yours**, and there is exactly one thing here that can prove it: **the bundle must be encrypted**. `pack --encrypt` seals it with AES-256-GCM; a bundle that decrypts under your passphrase was, by the authentication tag, sealed by someone holding that passphrase. `--trust-mine` on a plaintext bundle is **refused**, not warned about.

What it deliberately does **not** trust is the bundle's stated origin machine. That field is written by whoever built the bundle, so a hostile bundle can simply claim to be yours — gating on it would be security theatre. Authenticity comes from the crypto or not at all.

Even under `--trust-mine`:

- **Secrets still do not travel.** `env`/`headers` values remain `${VAR}` references; you get the server definition, never the token.
- **Machine-local keys still never move**, and your existing servers are merged with, not clobbered by, the bundle's.
- **Foreign absolute paths are reported.** A command pointing at the source machine's filesystem cannot work here, so it is listed loudly rather than written silently.
- **It is still a dry run without `--apply`, still journaled, and still reversible with `undo`.**

### Writes are reversible
`graft --apply` stages every write, records a journal (with a pre-write snapshot of anything it overwrites), then commits. `braingraft undo` replays the journal in reverse and restores the machine byte-for-byte. An interrupted graft is detected on the next run.

### Symlinks are written through, never replaced
If a destination path is a symlink (for example, a memory directory managed as a junction), Braingraft writes **through** it into the real target — it never replaces the link, which would silently fork your brain into two divergent copies. A link that resolves outside your Claude directory is refused unless you pass `--allow-external-links`.

## Encryption

`pack --encrypt` seals the compressed archive with AES-256-GCM. The key is derived with scrypt (N=2¹⁷, r=8, p=1) from your passphrase and a fresh 32-byte random salt; a fresh 12-byte nonce is used per bundle. The cleartext header (format, KDF parameters, salt, nonce) is bound into the GCM additional authenticated data, so it cannot be tampered independently of the ciphertext. The authentication tag is verified before a single byte of plaintext is produced. Wrong passphrase, corruption, and tampering all return one identical generic error — there is no oracle. A plaintext bundle is never silently accepted where encryption was expected.

Encryption is not a substitute for the allowlist: a bundle is designed to be safe to share *unencrypted*. Encryption protects a bundle in transit (a USB stick, an email attachment) and adds defense in depth for the memory prose it carries.

## Sync to a git remote

`sync push` queries the remote's **actual visibility before every push** and hard-refuses a public repository — a leaked private brain in public git history is permanent. The expected remote is pinned locally, so a silently repointed remote is refused too. Only GitHub visibility is auto-verified; any other host requires an explicit `--allow-unverified-remote` acknowledgement. The same secret scanner that gates `pack` gates every push. Paths in a pulled manifest are validated and root-confined before any file is read.

**Remote URLs are transport-restricted.** Every remote — for `push` *and* `pull` — is validated against a scheme allowlist (`https://`, `ssh://`, `git@host:`) before it ever reaches `git`, and every `git` subprocess runs with `protocol.ext`/`protocol.fd` disabled and `GIT_ALLOW_PROTOCOL=https:ssh:git`. This closes git's `ext::`/`fd::` remote-helper transports, which would otherwise let a crafted `--remote` value execute an arbitrary command the moment git touched it. A malicious "pull my brain" one-liner cannot run code on your machine.

## What Braingraft is not

It is not a sandbox and it does not vet the *intent* of instructions or hooks. It reduces the ways a bundle can surprise you and makes every change reversible; it cannot make an untrusted brain safe to run blindly. Read what you graft.
