# Changelog

## 0.2.0

**Renamed `claudeport` → `braingraft`.** The npm name `claudeport` belongs to an
unrelated project, so the tool is distributed from this GitHub repo and installs as
`braingraft`. The rename is designed to break nothing you already have:

- **URLs:** `github.com/1mp3ctz/claudeport` redirects to `.../braingraft` (GitHub keeps
  the old path alive after a repo rename).
- **Existing bundles:** the `.brain` format is unchanged. Bundles packed as `claudeport`
  still `inspect`/`graft`/`undo` under `braingraft`, including their `${CLAUDEPORT_HOME}`
  home token, which is still recognized on graft.
- **CLI name:** `braingraft` is the command; `claudeport` remains as an alias.
- **On-disk state:** new state lives in `.braingraft/`, but a prior `.claudeport/` journal
  is still read (so an `undo` after an old graft works) and an existing `.claudeport/sync`
  repo keeps being used.
- **Env vars:** `BRAINGRAFT_HOME` / `BRAINGRAFT_CLAUDE_DIR` / `BRAINGRAFT_PASSPHRASE` are
  the new names; the `CLAUDEPORT_*` equivalents still work as fallbacks.
- **Ignore file:** `.braingraftignore` is preferred; `.claudeportignore` is still honored.

### Security (found and fixed in pre-release review)

- **Sync transport RCE (critical):** a crafted `--remote` using git's `ext::`/`fd::`
  helper transport could execute arbitrary code. Remotes are now scheme-allowlisted and
  every `git` call disables those transports.
- **Trust-gate bypass (critical):** executable detection was inconsistent, letting a
  `.command` hook be written `+x` without tripping the "runs unreviewed code" gate.
  Detection is now unified.
- **Settings secret leak (high):** top-level `settings.json` `env`/`headers` values are
  now stripped wholesale regardless of key name.

## 0.1.0

Initial release as `claudeport`: `doctor`, `pack`, `inspect`, `graft`, `undo`, `sync`.
