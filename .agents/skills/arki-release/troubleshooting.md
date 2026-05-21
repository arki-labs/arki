# arki-release troubleshooting — pitfalls discovered the hard way

Battle-tested traps from real release sessions. Each one cost time; documented here so you don't pay again.

## The npm OTP wall

**Symptom:** `npm publish` fails with `npm error code EOTP — This operation requires a one-time password from your authenticator.`

**Root cause:** npm's default 2FA mode (`Authorization and publishing`) requires a fresh OTP for every write operation. The OTP must come from a human-controlled device (authenticator app, hardware key). An agent CANNOT generate it.

**Three solutions, ordered by appropriateness:**

1. **Manual loop in user's terminal** (best for one-shot publications):
   ```bash
   for p in <pkg-list>; do
     echo "=== Publishing @arki/$p ==="
     (cd .release/arki-public/packages/$p && npm publish --access public)
   done
   ```
   User runs this; npm prompts for OTP each time. ~30 seconds per OTP, ~5 minutes for 10 packages.

2. **Automation token** (best for repeat ships):
   ```bash
   npm token create --automation
   # Paste the token into ~/.npmrc:
   echo "//registry.npmjs.org/:_authToken=npm_xxxx" >> ~/.npmrc
   # Now `npm publish` works without OTP.
   # When done, revoke: npm token revoke <token-prefix>
   ```
   Tokens persist — revoke after the ship to limit blast radius.

3. **Lower 2FA mode** (last resort):
   `npmjs.com → Account Settings → Two-Factor Authentication → "Authorization only"`. Permanently weakens write security. Avoid.

**Agent contract:** when you hit EOTP, **stop and surface the manual-loop command**. Don't try to retry, don't ask for OTP-pass-through (each OTP is single-use ~30s, impractical for 10 packages).

## The `git add -A` parent-walk trap

**Symptom:** Running `git add -A` inside `.release/arki-public/` stages files from the parent monorepo (`apps/<x>/`, `tooling/<y>/`, `.claude/`). `git status` shows paths like `../../apps/avocabo/...`.

**Root cause:** `.release/arki-public/.git/` doesn't exist (e.g., never `git init`'d there, or was wiped by `export-public`'s `removeDirectory(outputPath)`). Git walks UP looking for a `.git/`, finds the monorepo's, and operates against THAT.

**Detect before damaging:**
```bash
cd /Users/afurculita/Developer/workspace/.release/arki-public
git rev-parse --git-dir
# MUST be:  /Users/afurculita/Developer/workspace/.release/arki-public/.git
# If it's the monorepo's path, STOP and run `git init -b main` first.
```

**Recover after damaging:** the index pollution is reversible via `git reset HEAD <path>`, but the workspace's "only-touch-own-edits" rule forbids `reset` on sibling-agent files. So:

- Don't reset their work.
- Commit ONLY your own paths with `git -c commit.gpgsign=false commit <my-paths> -m "..."`.
- Sibling agents will re-stage their work as they need.

## The `.git/` preservation gotcha during re-materialize

**Symptom:** You move `.release/arki-public/.git/` to `/tmp/...`, run `export-public`, move it back — and on the next `git status`, the `.git/` is gone.

**Root cause:** `export-public` calls `removeDirectory(outputPath)` which wipes `.release/arki-public/` entirely, including the parent dir (not just its contents). After mv-back, the directory recreation may have happened OR the timing got confusing. Often the actual issue is a `mv source destination` where `destination/` exists as a real dir → source ends up nested.

**Robust approach:** **don't preserve `.git/` across re-materialize**. Instead:

```bash
# 1. Re-materialize
bun tooling/arki-release/src/cli.ts export-public

# 2. Fresh init each time
cd .release/arki-public
git init -b main
git config user.name "Alexandru Furculita"
git config user.email "alex@furculita.net"
git config commit.gpgsign false
git add .
git commit -m "..."
git remote add origin git@github.com:arki-labs/arki.git
git push --force origin main
git tag -a v<version> -m "..."
git push origin v<version>
```

The GitHub history loses commit ancestry (each ship is a fresh single commit). That's a feature, not a bug — it matches the doctrine that the materialized tree is a generated mirror, not a development branch.

## Chicken-and-egg: transitive `@arki/*` deps in pre-publication state

**Symptom:** Fixture matrix (`bun release:arki fixture --full`) fails with `FIX_E004 install failed (exit 1)` for Wave 2/3 packages even though they pack cleanly.

**Root cause:** Wave 2/3 packages have `dependencies` like `"@arki/contracts": "0.0.1"`. When the fixture installs the tarball, npm tries to resolve `@arki/contracts@0.0.1` from the npm registry — but if that version was never published, install fails.

**Two solutions:**

1. **Ship in waves** — publish Wave 1 to npm first, then Wave 2 (its `@arki/*` deps now exist on npm), then Wave 3. Natural ordering that dissolves the cycle.
2. **Satellite tarball cache** — future fixture-matrix improvement. The matrix would stage all packed tarballs in a temp dir and tell the PM (via `overrides` or `--registry file://`) to resolve `@arki/*` from there. ~4-8 hours of tooling work, not done yet.

For now, accept that pre-publication Wave 2/3 packages can't be fixture-verified. The scorecard's `dot-gates` (kernel boot probe) is the next-best verifier.

## Fixture matrix probes assume a root `.` export

**Symptom:** `FIX_E005 ESM import probe failed` for packages like `@arki/assert`, `@arki/date` — even though the packages are pack-clean.

**Root cause:** The matrix's probe hardcodes `import * as pkg from "@arki/<name>"` (root specifier). Packages with subpath-only exports (`@arki/assert/base64`, `@arki/assert/language`, `@arki/assert/url` — no `.` entry) fail to resolve.

**Workaround:** acknowledge as known matrix limitation, don't treat as a publication blocker for subpath-only packages. The package's own tests cover the import paths properly.

**Real fix (future work, ~1-2 hours):** make the matrix inspect each package's exports map and template a real subpath into the probe instead of the bare specifier.

## "Stable release gate: BLOCKED" but I can't tell why

**Symptom:** Scorecard says BLOCKED; gate decision shows multiple packages with multiple blockers.

**Diagnostic incantation:**
```bash
# Get a machine-readable blocker breakdown
bun tooling/arki-release/src/cli.ts scorecard --json 2>/dev/null | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for it in data.get('items', []):
    if it.get('overall') != 'pass':
        print(f\"{it['name']} [{it['overall']}]\")
        for dim, d in it.get('dimensions', {}).items():
            if d.get('status') not in ('pass',):
                print(f\"  {dim}: {d['status']} — {d.get('details', '')}\")
"
```

Most common blockers:

| Dimension | Blocker meaning | Fix |
|---|---|---|
| `dot-gates: fail` | DOT probe couldn't boot 3 adapters OR contract arrays missing | Inspect `tooling/arki-release/src/dot-probe-runner.ts` output; verify `@arki/dot` + adapters are buildable |
| `dot-gates: deferred` | Probe skipped (`--skip-dot-probe`) | Re-run scorecard without that flag |
| `agent-native-gates: fail` | `dot new --dry-run --json` envelope invalid | Check `packages/dot/src/cli/new.ts` and the scaffold template |
| `build-output: fail` | Package missing `dist/*.js` or `dist/*.d.ts` | `turbo build --filter=@arki/<name>` |
| `privacy: fail` | Leak scanner caught an error-severity hit | Check `tooling/arki-release/src/leaks.ts` patterns; remove the offending text |
| `packlist: fail` | npm pack would include forbidden files (tests, .env, raw source) | Audit the package's `files` array |
| `docs: fail` | README or LICENSE missing | Add them |

## Python `json.dump` corrupts UTF-8

**Symptom:** Bumping a version via Python script produces a diff that re-encodes em-dashes (`—` → `—`) and other Unicode in unrelated description fields.

**Root cause:** Python's `json.dump` defaults to `ensure_ascii=True`, escaping every non-ASCII char.

**Fix:** Use `sed` for single-field edits:
```bash
sed -i '' 's/"version": "<old>"/"version": "<new>"/' packages/<name>/package.json
```

Or pass `ensure_ascii=False` if you really need Python:
```python
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
```

## Force-pushing destroys remote history

**Symptom:** `git push --force` to `arki-labs/arki main` succeeds and the old commits are gone from the default-branch history.

**By design:** the public repo is a regenerated mirror. Force-push is the intended sync mechanism. Old commits remain accessible via reflog/dangling-commit garbage collection windows (typically 30-90 days on GitHub).

**Safety protocol:**

1. Before force-pushing, clone the remote into `/tmp/arki-probe` and inspect what's there.
2. If you find content you don't recognize, STOP — surface to user.
3. If you find user's own old work, surface and get explicit "replace" authorization before force-push.
4. After force-push, GitHub keeps the abandoned commits temporarily — they can be recovered via the reflog UI if needed.
