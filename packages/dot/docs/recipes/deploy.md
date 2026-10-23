# Deploy an app

To ship an app made by `dot new`, build its container image, give it a
database URL, and check `/api/health`. This recipe assumes the default
`stack` template, which ships a `Dockerfile` and the health route.

```text
 docker build ──▶ image (server bundle + drizzle/ migrations)
                     │
 docker run ────────▶ boot: env check → migrations → units → start
                     │
 curl /api/health ──▶ {"status":"ok"}  (app started, Postgres answers)
```

## Steps

1. **Check the wiring without side effects.** `dot explain` only runs
   `configure`, so it touches no database:

   ```sh
   npx dot explain --json | jq -e '.ok'
   ```

2. **Run the tests.** The template's tests boot the app on in-memory PGlite,
   so they need no Docker:

   ```sh
   bun run test
   ```

3. **Build the image.** The `Dockerfile` has three stages: install from the
   lockfile, build the server bundle, then copy only `.output/` and
   `drizzle/` into a small runner image:

   ```sh
   docker build -t pizzeria .
   ```

4. **Run it with a database URL.** The other variables are listed in
   `.env.example`:

   ```sh
   docker run -p 3000:3000 -e DB_URL=postgres://app:secret@db.internal:5432/app pizzeria
   ```

   On boot, the `dbMigrations` unit applies the migrations in `drizzle/`
   to that database. `SIGTERM` (what `docker stop` sends) drains the app:
   `stop` hooks run, then `dispose` hooks, in reverse order.

## Why it works this way

- **Migrations ship inside the image.** Code and schema travel together, so
  a container never runs against a schema it does not know. The cost: the
  first boot of a new version changes the database. Keep migrations
  backward compatible if you want to roll back by redeploying the old
  image.
- **Every stage uses the musl Bun image.** A Bun binary copied from a glibc
  image into Alpine crashes on start. That bug is boring to find twice.
- **The health route checks Postgres too.** It starts the app if needed
  and runs `select 1`. It answers `503` when either fails, so the platform
  does not route traffic to a container that cannot serve it.

## Check it

With the container running, this command prints the health answer:

```sh
curl -fsS http://localhost:3000/api/health
```

Expected output:

```text
{"status":"ok"}
```
