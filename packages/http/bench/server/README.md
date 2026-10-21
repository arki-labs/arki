# Server benchmark

One workload, one file per server, one runner. `run.ts` starts each server on Bun and on Node, checks that every response is byte-identical to the others, then measures with [`oha`](https://github.com/hatoo/oha): requests per second, latency, and **server CPU microseconds per request** (each server prints `process.cpuUsage()` on `SIGUSR2`). The CPU number is the one to compare: it stays stable when the machine is busy, throughput does not.

```sh
brew install oha
bun run bench:server                                   # builds dist, runs every server
bun bench/server/run.ts --only arki,arki-hono,hono     # a subset
bun bench/server/run.ts --node ~/.nvm/versions/node/v26.11.1/bin/node --scenarios ping
```

Routes: `GET /ping`, `GET /users/:id`, `POST /items` (JSON body validated with the same zod schema everywhere); `GET /nope` → 404 and an invalid body → 400 are checked, not timed.

`arki` is `@arki/http` as shipped (compiled engine, native Bun route table through `listen`); `arki-hono` is the Hono engine alone; `arki-fetch` is the compiled engine without the Bun route table. `bun-raw`, `bun-routes` and `node-raw` are hand-written ceilings. Results land in `results/` (git-ignored except the ones cited in the README).
