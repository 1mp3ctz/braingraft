# Contributing

Thanks for looking. Claudeport is deliberately small and dependency-free — please keep it that way.

## Ground rules

- **Zero runtime dependencies.** Node standard library only. A PR that adds a dependency to `bin/` or `src/` will not be merged.
- **Plain ESM, no build step.** `src/*.mjs` runs as-is.
- **Never write to a real `~/.claude` from a test.** Tests build a fake tree in a temp dir and point `CLAUDEPORT_HOME` at it (see `test/fixture.mjs`).
- **Safety changes need a test.** Anything touching extraction, the secret scanner, the settings merge, the memory remap, or the journal must come with a regression test.

## Running the tests

```bash
npm test        # node --test, no install needed
```

## Layout

```
bin/claudeport.mjs   CLI entry, arg parsing, dispatch
src/doctor.mjs       read-only diagnosis
src/pack.mjs         build a bundle (allowlist, redaction, tokenizing)
src/inspect.mjs      verify a bundle from its bytes
src/graft.mjs        plan + apply, dry-run by default
src/sync.mjs         git-backed push/pull
src/tar.mjs          hardened ustar reader/writer + validation
src/container.mjs    .brain container + optional AES-256-GCM
src/settings.mjs     per-key settings policy + merge
src/memory.mjs       namespace remap (the core fix)
src/journal.mjs      staged writes, snapshot, undo
```

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please use a private advisory, not a public issue.
