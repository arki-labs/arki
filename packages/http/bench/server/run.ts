// End-to-end server benchmark: @arki/http against the frameworks it could be built on, over a real socket.
// Run: `bun run bench:server` in the package directory (builds dist first), or `bun bench/server/run.ts`.
//   --only a,b        servers to run (names from SERVERS)        --scenarios ping,param,post
//   --duration 5      seconds per timed run                       --warmup 2    seconds, discarded
//   --repeat 3        timed runs per scenario, best kept          --conns 64    open connections
//   --node <path>     Node binary (default: `node` on PATH)       --oha <path>  oha binary (default: `oha`)
// For each server x runtime: spawn, wait for READY, verify every response is byte-identical, then oha.
// Reports server CPU microseconds per request (process.cpuUsage() on SIGUSR2) next to req/s: the CPU
// number stays stable when the machine is busy, the req/s number does not.
import { spawn } from 'bun';
import { loadavg } from 'node:os';

const args = process.argv.slice(2);
const opt = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1]! : fallback; };
const NODE = opt('--node', 'node');
const BUN = process.execPath;
const OHA = opt('--oha', 'oha');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

type Runtime = 'bun' | 'node';
type ServerSpec = { name: string; file: string; runtimes: Runtime[] };
const SERVERS: ServerSpec[] = [
  // ceilings
  { name: 'bun-raw', file: 'bun-raw.ts', runtimes: ['bun'] },
  { name: 'bun-routes', file: 'bun-routes.ts', runtimes: ['bun'] },
  { name: 'node-raw', file: 'node-raw.ts', runtimes: ['node'] },
  // @arki/http
  { name: 'arki', file: 'arki.ts', runtimes: ['bun', 'node'] },
  { name: 'arki-hono', file: 'arki-hono.ts', runtimes: ['bun', 'node'] },
  { name: 'arki-fetch', file: 'arki-fetch.ts', runtimes: ['bun'] },
  // frameworks
  { name: 'hono', file: 'hono-bun.ts', runtimes: ['bun'] },
  { name: 'hono-node', file: 'hono-node.ts', runtimes: ['node'] },
  { name: 'rawfetch-hono-node', file: 'rawfetch-hono-node.ts', runtimes: ['node'] },
  { name: 'elysia', file: 'elysia-bun.ts', runtimes: ['bun'] },
  { name: 'elysia-typebox', file: 'elysia-typebox-bun.ts', runtimes: ['bun'] },
  { name: 'elysia-node', file: 'elysia-node.ts', runtimes: ['node'] },
  { name: 'srvx-raw', file: 'srvx-raw.ts', runtimes: ['bun', 'node'] },
  { name: 'hono-srvx', file: 'hono-srvx.ts', runtimes: ['bun', 'node'] },
  { name: 'h3-srvx', file: 'h3-srvx.ts', runtimes: ['bun', 'node'] },
  { name: 'fastify', file: 'fastify-node.ts', runtimes: ['node'] },
];

const POST_BODY = JSON.stringify({ name: 'x', qty: 3, tags: ['a'] });
type Scenario = { name: string; path: string; method: 'GET' | 'POST'; body?: string; expectStatus: number; expectBody?: string };
const SCENARIOS: Scenario[] = [
  { name: 'ping', path: '/ping', method: 'GET', expectStatus: 200, expectBody: '{"ok":true}' },
  { name: 'param', path: '/users/abc123', method: 'GET', expectStatus: 200, expectBody: '{"id":"abc123","name":"item"}' },
  { name: 'post', path: '/items', method: 'POST', body: POST_BODY, expectStatus: 200, expectBody: '{"ok":true,"name":"x"}' },
];
const CHECKS_ONLY: Scenario[] = [
  { name: '404', path: '/nope', method: 'GET', expectStatus: 404 },
  { name: 'invalid', path: '/items', method: 'POST', body: '{"name":"","qty":0,"tags":[]}', expectStatus: 400 },
];

const only = opt('--only', '').split(',').filter(Boolean);
const duration = opt('--duration', '8');
const warmup = opt('--warmup', '2');
const conns = opt('--conns', '64');
const repeat = Number(opt('--repeat', '3'));
const scenarioFilter = opt('--scenarios', '').split(',').filter(Boolean);

type Row = { server: string; runtime: Runtime; scenario: string; rps: number; cpuUs: number; p50ms: number; p99ms: number; errors: number; load: number; note?: string };
const rows: Row[] = [];

const sleep = (ms: number) => new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms));

/** Drains a child's stdout into lines; `waitFor` resolves with the first new line matching `re`. */
class Lines {
  private lines: string[] = [];
  private partial = '';
  private waiters: { re: RegExp; resolve: (line: string) => void }[] = [];
  closed = false;
  constructor(stdout: ReadableStream<Uint8Array>) {
    void (async () => {
      const reader = stdout.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (r.done) break;
        this.partial += dec.decode(r.value);
        const parts = this.partial.split('\n');
        this.partial = parts.pop() ?? '';
        for (const line of parts) {
          this.lines.push(line);
          const i = this.waiters.findIndex(w => w.re.test(line));
          if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(line);
        }
      }
      this.closed = true;
      for (const w of this.waiters) w.resolve('');
      this.waiters = [];
    })();
  }
  all(): string { return this.lines.join('\n'); }
  waitFor(re: RegExp, ms: number): Promise<string> {
    return new Promise(resolve => {
      const w = { re, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); resolve(''); } }, ms);
    });
  }
}

async function waitReady(proc: ReturnType<typeof spawn>, out: Lines): Promise<void> {
  const line = await out.waitFor(/READY/, 15000);
  if (line === '') throw new Error(`no READY within 15s (exit ${proc.exitCode}):\n${out.all().slice(0, 400)}`);
}

/** CPU microseconds (user+system) the server has used so far, via SIGUSR2. */
async function cpuMicros(proc: ReturnType<typeof spawn>, out: Lines): Promise<number> {
  const pending = out.waitFor(/^CPU /, 3000);
  process.kill(proc.pid, 'SIGUSR2');
  const line = await pending;
  if (line === '') throw new Error('no CPU line after SIGUSR2');
  return Number(line.slice(4));
}

async function verify(s: Scenario): Promise<string | undefined> {
  const res = await fetch(`${BASE}${s.path}`, { method: s.method, headers: s.body ? { 'content-type': 'application/json' } : {}, body: s.body });
  const text = await res.text();
  if (res.status !== s.expectStatus || (s.expectBody !== undefined && text !== s.expectBody)) return `${s.name}: got ${res.status} ${text}`;
  return undefined;
}

type OhaJson = { summary: { requestsPerSec: number; successRate: number; total: number }; latencyPercentiles: { p50: number; p99: number }; statusCodeDistribution: Record<string, number>; errorDistribution: Record<string, number> };
async function oha(s: Scenario, seconds: string): Promise<OhaJson> {
  const cmd = [OHA, '--no-tui', '--output-format', 'json', '-z', `${seconds}s`, '-c', conns, '-m', s.method];
  if (s.body) cmd.push('-H', 'content-type: application/json', '-d', s.body);
  cmd.push(`${BASE}${s.path}`);
  const p = spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`oha exit ${p.exitCode}: ${err.slice(0, 300)}`);
  return JSON.parse(out) as OhaJson;
}

for (const spec of SERVERS) {
  if (only.length && !only.includes(spec.name)) continue;
  for (const runtime of spec.runtimes) {
    const label = `${spec.name}@${runtime}`;
    const exe = runtime === 'bun' ? BUN : NODE;
    const proc = spawn([exe, `${import.meta.dir}/servers/${spec.file}`], { env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' });
    const out = new Lines(proc.stdout as ReadableStream<Uint8Array>);
    try {
      await waitReady(proc, out);
      const problems = (await Promise.all([...SCENARIOS, ...CHECKS_ONLY].map(verify))).filter(Boolean);
      if (problems.length) {
        console.log(`✗ ${label}: ${problems.join(' | ')}`);
        for (const s of SCENARIOS) rows.push({ server: spec.name, runtime, scenario: s.name, rps: 0, cpuUs: 0, p50ms: 0, p99ms: 0, errors: 0, load: 0, note: problems.join('; ') });
        continue;
      }
      for (const s of SCENARIOS) {
        if (scenarioFilter.length && !scenarioFilter.includes(s.name)) continue;
        await oha(s, warmup);
        let best: Row | undefined;
        for (let i = 0; i < repeat; i++) {
          const cpuBefore = await cpuMicros(proc, out);
          const r = await oha(s, duration);
          const cpuAfter = await cpuMicros(proc, out);
          const served = Object.values(r.statusCodeDistribution).reduce((n, v) => n + v, 0);
          const errors = Object.entries(r.statusCodeDistribution).filter(([k]) => k !== String(s.expectStatus)).reduce((n, [, v]) => n + v, 0) + Object.entries(r.errorDistribution).filter(([k]) => !/deadline/i.test(k)).reduce((n, [, v]) => n + v, 0);
          const row: Row = { server: spec.name, runtime, scenario: s.name, rps: Math.round(r.summary.requestsPerSec), cpuUs: +((cpuAfter - cpuBefore) / Math.max(served, 1)).toFixed(1), p50ms: +(r.latencyPercentiles.p50 * 1000).toFixed(2), p99ms: +(r.latencyPercentiles.p99 * 1000).toFixed(2), errors, load: +loadavg()[0]!.toFixed(0) };
          if (best === undefined || row.cpuUs < best.cpuUs) best = row;
        }
        rows.push(best!);
        console.log(`  ${label} ${s.name}: ${best!.cpuUs} µs/req  ${best!.rps} rps  p99 ${best!.p99ms}ms  errors ${best!.errors}  load ${best!.load}`);
      }
    } catch (e) {
      proc.kill();
      await proc.exited;
      const err = await new Response(proc.stderr).text().catch(() => '');
      console.log(`✗ ${label}: ${(e as Error).message}\n${err.slice(0, 600)}`);
      for (const s of SCENARIOS) rows.push({ server: spec.name, runtime, scenario: s.name, rps: 0, cpuUs: 0, p50ms: 0, p99ms: 0, errors: 0, load: 0, note: (e as Error).message.split('\n')[0] });
    } finally {
      proc.kill();
      await proc.exited;
    }
  }
}

// ---- table: one line per server@runtime, columns per scenario
const byKey = new Map<string, Row[]>();
for (const r of rows) { const k = `${r.server}@${r.runtime}`; byKey.set(k, [...(byKey.get(k) ?? []), r]); }
const lines = ['| server | runtime | ping µs/req | param µs/req | post µs/req | ping rps | param rps | post rps | ping p99 ms | load | note |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|'];
const entries = [...byKey.entries()].sort((a, b) => ((a[1][0]?.cpuUs || 1e9) - (b[1][0]?.cpuUs || 1e9)));
for (const [k, rs] of entries) {
  const get = (n: string) => rs.find(r => r.scenario === n);
  const [server, runtime] = k.split('@');
  const note = rs.find(r => r.note)?.note ?? (rs.some(r => r.errors > 0) ? `errors: ${rs.map(r => r.errors).join('/')}` : '');
  lines.push(`| ${server} | ${runtime} | ${get('ping')?.cpuUs ?? ''} | ${get('param')?.cpuUs ?? ''} | ${get('post')?.cpuUs ?? ''} | ${get('ping')?.rps ?? ''} | ${get('param')?.rps ?? ''} | ${get('post')?.rps ?? ''} | ${get('ping')?.p99ms ?? ''} | ${get('ping')?.load ?? ''} | ${note} |`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await Bun.write(`${import.meta.dir}/results/${stamp}.json`, JSON.stringify({ duration, warmup, conns, repeat, rows }, null, 2));
await Bun.write(`${import.meta.dir}/results/${stamp}.md`, lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
console.log(`\nsaved bench/server/results/${stamp}.{json,md}`);
