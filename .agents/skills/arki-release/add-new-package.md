# Promote a private package to a public wave

When a `@arki/*` package matures enough to ship publicly, this is the procedure.

Only `packages/` (`@arki/*`) can be promoted. A `fleet/` (`@fleet/*`) package is never released: first move it into Arki (RFC [`2026-10-17-fleet-packages.md`](../../../docs/rfcs/2026-10-17-fleet-packages.md) § 6), then come back here.

## Eligibility — must pass before promotion

Run `bun tooling/arki-release/src/cli.ts inventory` to see current classification. The package must:

- Have `"private": false` in its source `package.json`.
- Have a `description`, `repository`, `homepage`, `bugs`, `license` (or accept the materializer's defaults from `arki.release.config.ts`).
- Ship compiled `dist/*.js` + `dist/*.d.ts` after `turbo build --filter=@arki/<name>`.
- Have a `README.md` and a `LICENSE` file.
- Have all its transitive `@arki/*` deps already in a published wave (or the same wave being promoted).
- Pass `bun release:arki audit` (no leak hits except acceptable `warning`s).
- Have a benchmark against its most popular competitors: a `bench/<name>.bench.ts` suite on `@arki/bench` (`packages/bench/`), `"bench": "bun run build && arki-bench"`, and a README section between `<!-- bench:start -->` / `<!-- bench:end -->` written by `bun run bench --profile publish --write-readme` on an idle machine. Compare groups keep one written contract checked before timing; rivals that keep a different promise are `differs`. Speed for runtime code; bundle size for UI, CSS and icon packages. Founder rule, 2026-10-13.

If any check fails, the package isn't ready. Don't try to force-fit it — fix the underlying issue first.

## Promotion steps

```bash
# 1. Confirm eligibility — inventory + scorecard
bun tooling/arki-release/src/cli.ts inventory | grep "@arki/<name>"
# Expected: classification=unassigned (or already-allowlisted but not in a wave)

# 2. If still marked `private: true`, flip it
sed -i '' 's/"private": true/"private": false/' packages/<path>/package.json

# 3. Add to a wave in arki.release.config.ts
# Open arki.release.config.ts; find the right wave; add the package name to its `packages` array.
# Wave choices:
#   - foundation         — zero @arki/* deps, pure utilities (assert, log, etc.)
#   - dot-kernel         — @arki/dot itself
#   - infrastructure-adapters  — DOT adapters (db, kv, env, queue, …)
#   - frontend           — UI / React-coupled packages
#   - specialized        — anything else

# 4. Verify scorecard — package should now appear and PASS
bun tooling/arki-release/src/cli.ts scorecard | grep "@arki/<name>"
# Expected: @arki/<name> — PASS

# 5. Confirm gate is still OPEN
bun tooling/arki-release/src/cli.ts scorecard | tail -3
# Expected: Stable release gate: OPEN

# 6. Write a changeset entry — initial publication is a patch on the package's current 0.x version
#    (below 1.0 a breaking change is a minor; see decisions.md "Reconciled guidance")
cat > .changeset/<slug>.md <<'EOF'
---
'@arki/<name>': patch
---

Initial public release of @arki/<name>.
EOF
# Or use `bunx -p @changesets/cli changeset` interactively.

# 7. Apply changeset, re-materialize, publish, sync (see ship-update.md from step 2 onward)
```

## Initial-version decision

Changesets will bump from whatever's in source today. To start publishing at `0.0.1`:

```bash
# Edit source to 0.0.1 directly BEFORE running `changeset version`
sed -i '' 's/"version": "[^"]*"/"version": "0.0.1"/' packages/<path>/package.json
```

Or, if the source is already at some experimental version (e.g., 0.1.0), the `changeset version` patch bump produces 0.1.1. That's fine too — pick whatever matches the rest of the wave's track.

## Cross-package promotion (multiple new packages at once)

When promoting several packages together (e.g., a new wave), batch the steps:

1. Flip every package's `private: true` → `false` in one pass.
2. Add all of them to the appropriate wave entries.
3. **Run the scorecard ONCE** — it catches inter-package dep cycles or leaks faster than per-package iteration.
4. Write a single multi-package changeset entry:
   ```
   ---
   '@arki/pkg1': patch
   '@arki/pkg2': patch
   '@arki/pkg3': patch
   ---

   Initial public release of <wave-name>.
   ```
5. Publish in order: leaves first (no `@arki/*` deps), then roots. The npm registry resolves transitive deps at install time, so leaves must exist before consumers.

## Common refusals

| Inventory says | Means | Fix |
|---|---|---|
| `blocked-by-private-flag` | Package is in a wave but `private: true` | Drop the private flag |
| `blocked-by-private-dependency` | Depends on a still-private `@arki/*` | Promote the dep first, or remove the dep |
| `blocked-by-build-shape` | No `dist/`, missing `.d.ts`, missing exports | Run `turbo build --filter=@arki/<name>` |
| `unassigned` | Not `private` but not in any wave | Add to a wave or set `private: true` |

## Watch points

- **Promotion is reversible up until publish** — until `npm publish` runs, you can `git revert` and the package goes back to private. After publish, the package exists on npm forever (you can deprecate but not unpublish after 72 hours).
- **Test the package before promoting** — `bun run test --filter=@arki/<name>` and `bun run typecheck --filter=@arki/<name>`. The scorecard doesn't run tests; it only checks publication shape.
- **Update `.changeset/README.md`** if the wave's published roster materially changed — the README has a human-readable wave list that should reflect reality.
