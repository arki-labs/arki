---
'@arki/dot': minor
---

New command `dot dev`. It picks the app's `dev` export, then resolves the database: embedded PGlite, or a local Postgres it can start with `docker compose up -d`. A non-local `DB_URL` / `DATABASE_URL` in the process env or any `.env*` file is refused, under PGlite too, unless you pass `--allow-remote-db`. A PGlite runner starts without any database URL. A preflight boot then validates env and applies the committed `drizzle/` migrations, and prints which ones it applied. After that it runs Vite (or `--run`, or the hidden `dot _serve`) in its own process group, and restarts when `drizzle/`, `.env*` or the app file change. `--once` stops after the preflight: it is the boot check for CI and agents.

New in `@arki/dot/cli`: `runDev`, `devEventSchema` / `DevEvent`, `devStateSchema` / `DevState`, `DEV_STATE_PATH`, and the failures `DevDbUnreachable`, `DevRunnerFailed`, `DevPortInUse`, `DevAlreadyRunning`, `DevRemoteDbRefused`, `DevAppStarted`. Discovery takes `prefer: 'dev'`, and `DiscoveryResult` carries `exportName`. `DoctorOptions.onBooted` hands the booted app to the caller before it is disposed.
