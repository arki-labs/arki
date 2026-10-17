# Upgrade Dot

To move an app to a new `@arki/dot` version, read what changed, bump every
`@arki/*` package at once, let the compiler list the work, then boot-check
the app.

```text
 read CHANGELOG ─▶ bump ─▶ tsc (the to-do list) ─▶ dot explain ─▶ dot doctor
```

## Steps

1. **Read the changes.** Open `CHANGELOG.md` in `node_modules/@arki/dot/`
   after the bump, or on GitHub before it. Dot is `0.x`: a minor version can
   break the API (see [Release policy](../release-policy.md)). Breaking
   changes come with before and after code in the
   [Upgrade guide](../upgrade-guide.md).

2. **Bump `@arki/dot` and its adapters together.** Adapters such as
   `@arki/db` and `@arki/env` take `@arki/dot` as a peer dependency, so
   they must agree on one version:

   ```sh
   bun update @arki/dot @arki/db @arki/env
   ```

   List every `@arki/*` package your app uses, not only these three.

3. **Typecheck.** Wiring is checked at `.use()`, so a changed contract shows
   up as compile errors at the lines you need to touch:

   ```sh
   npx tsc --noEmit
   ```

4. **Check the graph without side effects.** `dot explain` only runs
   `configure`:

   ```sh
   npx dot explain --json | jq -e '.ok'
   ```

5. **Boot-check.** `dot doctor` boots the app and disposes it. It opens real
   connections and applies pending migrations, so point it at a local or
   staging database, never at production.

## Why this order

The compiler is the cheapest check, so it goes first. `dot explain` comes
next because it cannot touch data. `dot doctor` comes last because it is the
only step with side effects.

## Check it

After the steps above, this command prints the doctor status:

```sh
npx dot doctor --json | jq -r '.data.status'
```

Expected output:

```text
success
```
