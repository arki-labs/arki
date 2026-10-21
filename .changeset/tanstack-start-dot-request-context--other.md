---
'@arki/tanstack-start': minor
---

`@arki/tanstack-start/dot` adds `tanstackStart()`, the TanStack Start entrypoint of a Dot app. It takes typed `needs`, a `session` and an `rpc` function, and declares the `rpc`, `auth`, `cron` and `health` mounts at their `at` paths, so `dot explain` lists them. `rpcHandlers()`, `authHandlers()`, `cronHandlers()` and `healthHandlers()` make each mount a one-line server route. `startServer(app, { hot, eager, handler })` from `@arki/tanstack-start/server` owns the app runtime and hands every Start request a typed context (`services`, `rpc`, `session()`, `requestId`, `signal`); type it once with `RequestContextOf<typeof app>` in a `Register` augmentation of `@tanstack/react-start`.

Breaking: `createServerHandler` is removed; use `startServer`. The cron mount's `secret` and the `cors` option are functions read at boot (`secret: () => env.CRON_SECRET`), so `vite build` runs without the server env; a bad value stops the boot with `ARKI_TANSTACK_START_PLUGIN_E001` (cron secret) or `ARKI_TANSTACK_START_PLUGIN_E002` (CORS).

`@arki/dot`: `createAppRuntime(app, { eager: true })` starts the app when the runtime is created, so a production server boots before its first request.
