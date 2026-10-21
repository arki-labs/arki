// Composition: @arki/dot against awilix, on the same 20-service graph.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Bringing the graph up is different work in dot and awilix (lifecycle,
// ordering, diagnostics), so it is a scenario without ratios. Looking up a
// service after boot is the same work in both and is ranked.

import type { AwilixContainer } from 'awilix';
import { asFunction, createContainer, InjectionMode } from 'awilix';

import { compare, defineSuite, scenario } from '@arki/bench';
import { defineApp, infra, service } from '@arki/dot';

const COUNT = 20;
const LAST: Key = `s${COUNT - 1}`;

type Service = { id: number; deps: number };
type Key = `s${number}`;
type Services = Record<Key, Service>;

// Service i depends on the two services before it (i-1 and i-2), so the graph
// is a real dependency web, not a flat list. Every service is a small object.
const depsOf = (index: number): Key[] => [index - 1, index - 2].filter(j => j >= 0).map((j): Key => `s${j}`);
const make = (index: number, deps: Record<string, unknown>): Service => ({ id: index, deps: Object.keys(deps).length });

// ---- @arki/dot: 20 units, declaration order is boot order.
const units = Array.from({ length: COUNT }, (_, index) => {
  const needs: Record<Key, ReturnType<typeof service<Service>>> = {};
  for (const key of depsOf(index)) needs[key] = service<Service>();
  const provides: Record<Key, (ctx: Record<Key, Service>) => Service> = {
    [`s${index}`]: (ctx: Record<Key, Service>) => {
      const deps: Record<Key, Service> = {};
      for (const key of depsOf(index)) deps[key] = ctx[key];
      return make(index, deps);
    },
  };
  return infra({ name: `p${index}`, needs, provides });
});

async function bootDot() {
  let builder = defineApp('bench');
  for (const each of units) builder = builder.infra(each);
  return builder.boot();
}

// ---- awilix: the same graph as singleton factories, resolved through the cradle proxy.
function awilixContainer(): AwilixContainer<Services> {
  const container = createContainer<Services>({ injectionMode: InjectionMode.PROXY });
  for (let index = 0; index < COUNT; index++) {
    const keys = depsOf(index);
    container.register(
      `s${index}`,
      asFunction((cradle: Services) =>
        make(index, Object.fromEntries(keys.map(key => [key, cradle[key]]))),
      ).singleton(),
    );
  }
  return container;
}

function awilixResolveAll(container: AwilixContainer<Services>): Service {
  let last = container.resolve<Service>('s0');
  for (let index = 1; index < COUNT; index++) last = container.resolve<Service>(`s${index}`);
  return last;
}

// ---- Hand-written wiring: the floor. No container, no lifecycle, no diagnostics.
function handWired(): Services {
  const services: Services = {};
  for (let index = 0; index < COUNT; index++) {
    const deps = Object.fromEntries(depsOf(index).map(key => [key, services[key]]));
    services[`s${index}`] = make(index, deps);
  }
  return services;
}

// ---- Booted fixtures for the lookup group, built once at module load.
const dotApp = await bootDot();
const dotServices: Services = dotApp.services;
const hotContainer = awilixContainer();
awilixResolveAll(hotContainer);
const hotServices = handWired();

/**
 * The lookup contract: the service with the right id and dependency count,
 * and the very instance the booted graph holds (a singleton, not a new build).
 */
const marker = (found: Service, held: unknown): string =>
  `s${found.id} deps=${found.deps} ${found === held ? 'booted instance' : 'NEW instance'}`;

export default defineSuite({
  id: '@arki/dot',
  intro:
    'A 20-service graph where each service depends on the two before it, built with `@arki/dot` units and with awilix, the most used dependency-injection container for Node. A hand-wired version is the floor: no container at all.',
  notes: [
    '`@arki/dot` and awilix do different jobs. awilix is a container: it registers factories and builds them on first use. dot runs an application lifecycle: it orders units by their declared needs, runs `configure`, `boot` and `dispose` hooks in order (and in reverse on shutdown), checks the wiring at compile time, and records a manifest and diagnostics for every unit.',
    'So bringing the graph up is shown as a scenario, without ratios: the rows show what each approach costs, not that they are interchangeable. Boot is async in dot (unit hooks may await); awilix resolves synchronously.',
    'Looking up a service after boot is the same work everywhere and is ranked. The check confirms each row returns the instance its booted graph holds, not a fresh build.',
  ],
  groups: [
    scenario({
      id: 'bring-up',
      title: 'Build the graph and bring it up (20 services)',
      note: 'Different work per row; compare each row with its own history. dot: declare 20 units, boot, dispose. awilix: create a container, register 20 factories, resolve all 20, dispose. Hand-wired: build the 20 objects in order.',
      mode: 'async',
      cases: {
        dot: {
          label: '@arki/dot (boot + dispose)',
          package: '@arki/dot',
          run: async () => {
            const app = await bootDot();
            await app.dispose();
            return app;
          },
        },
        awilix: {
          label: 'awilix (register + resolve + dispose)',
          package: 'awilix',
          run: async () => {
            const container = awilixContainer();
            const last = awilixResolveAll(container);
            await container.dispose();
            return last;
          },
        },
        hand: {
          label: 'hand-written wiring (no container)',
          run: async () => handWired(),
        },
      },
    }),
    compare<Key>({
      id: 'lookup',
      title: 'Look up a service after boot',
      note: 'The hot path: code that already has a booted graph asks for one service. dot services are plain properties; awilix `resolve` and `cradle` go through a cache lookup.',
      contract: {
        id: 'dot-lookup/v1',
        description: 'the booted singleton for the key (same instance on every call), never a new build',
      },
      inputs: ['s0', 's1', 's7', LAST] satisfies Key[],
      expected: key => {
        const index = Number(key.slice(1));
        return `${key} deps=${Math.min(index, 2)} booted instance`;
      },
      baseline: 'dot',
      cases: c => ({
        dot: c({
          label: '@arki/dot (app.services[key])',
          package: '@arki/dot',
          run: (key: Key) => dotServices[key]!,
          normalize: found => marker(found, dotServices[`s${found.id}`]),
        }),
        awilixResolve: c({
          label: 'awilix (container.resolve(key))',
          package: 'awilix',
          run: (key: Key) => hotContainer.resolve<Service>(key),
          normalize: found => marker(found, hotContainer.cache.get(`s${found.id}`)?.value),
        }),
        awilixCradle: c({
          label: 'awilix (container.cradle[key])',
          package: 'awilix',
          run: (key: Key) => hotContainer.cradle[key]!,
          normalize: found => marker(found, hotContainer.cache.get(`s${found.id}`)?.value),
        }),
        hand: c({
          label: 'hand-written (plain object property)',
          run: (key: Key) => hotServices[key]!,
          normalize: found => marker(found, hotServices[`s${found.id}`]),
        }),
      }),
    }),
  ],
});
