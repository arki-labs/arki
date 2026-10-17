# Back up and restore a database

Goal: take a copy of a Postgres database that `@arki/db` talks to, restore it into a fresh database, and prove the copy matches.

Use this before a risky migration, and to rehearse recovery. A backup you never restored is a guess.

## What you need

- `pg_dump` and `pg_restore` of the same major version as the server.
- `DB_URL`: the connection URL of the database the app uses.
- A second, empty database for the restore. Never restore over the live one.

## 1. Take the backup

The custom format (`-Fc`) is compressed and lets `pg_restore` pick what to restore.

```sh
pg_dump --format=custom --no-owner --file=backup.dump "$DB_URL"
```

`pg_dump` reads a consistent snapshot. Writers are not blocked.

## 2. Restore into an empty database

```sh
createdb restore_check
pg_restore --no-owner --dbname=restore_check backup.dump
```

`--no-owner` makes the objects belong to the user who restores. That is what you want on a scratch database.

## 3. Embedded PGlite

A PGlite data directory is plain files. Close the handle first (`pglite.close()`), then copy the directory.

```sh
cp -R ./.local/db ./.local/db.backup
```

A directory that is open has an owner lock (`.arki-owner`). Copying it while the app runs can give a broken copy. Stop the app, then copy.

## 4. Run migrations on the restored copy

`dbMigrations()` applies pending migrations at boot. Point a boot at the restored database and the schema is brought up to date. If a migration folder changed since the backup, this step shows it.

## Check it worked

Count the rows of one table in both databases. Replace `users` with a table of yours.

```sh
psql "$DB_URL" -tAc "select count(*) from users"; psql restore_check -tAc "select count(*) from users"
```

Expected output: the same number twice, one per line. For a table with 42 rows:

```text
42
42
```

If the numbers differ, writes happened between the backup and the check. Take the count again right after the dump, or run the check against a quiet database.
