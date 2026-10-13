import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

import { debugContainers } from './debug';

export const POSTGRES_GLOBAL_KEY = '__POSTGRES_CONNECTION_STRING__';
export const REDIS_GLOBAL_KEY = '__REDIS_CONNECTION_STRING__';

export type SharedContainerOptions = {
  postgresImage?: string;
  redisImage?: string;
};

let sharedPostgresContainer: StartedPostgreSqlContainer | undefined;
let sharedRedisContainer: StartedTestContainer | undefined;

export async function startPostgresContainer(image = 'postgres:16'): Promise<StartedPostgreSqlContainer> {
  debugContainers.debug('[containers] Starting PostgreSQL container (image: {image})', { image });
  const container = await new PostgreSqlContainer(image)
    .withDatabase('test')
    .withUsername('test')
    .withPassword('test')
    .start();
  debugContainers.debug('[containers] PostgreSQL container started (uri: {uri})', {
    uri: container.getConnectionUri(),
  });
  return container;
}

export async function startRedisContainer(image = 'redis:7-alpine'): Promise<StartedTestContainer> {
  debugContainers.debug('[containers] Starting Redis container (image: {image})', { image });
  const container = await new GenericContainer(image).withExposedPorts(6379).start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  debugContainers.debug('[containers] Redis container started (host: {host}, port: {port})', { host, port });
  return container;
}

export function getGlobalPostgresConnectionString(): string | undefined {
  const connectionString = (global as any)[POSTGRES_GLOBAL_KEY];
  debugContainers.debug('[containers] Getting global Postgres connection (exists: {exists})', {
    exists: !!connectionString,
  });
  return connectionString;
}

export function getGlobalRedisConnectionString(): string | undefined {
  const connectionString = (global as any)[REDIS_GLOBAL_KEY];
  debugContainers.debug('[containers] Getting global Redis connection (exists: {exists})', {
    exists: !!connectionString,
  });
  return connectionString;
}

export async function setupGlobalTestContainers(options?: SharedContainerOptions): Promise<void> {
  debugContainers.debug(
    '[containers] Setting up global test containers (pgImage: {pgImage}, redisImage: {redisImage})',
    { pgImage: options?.postgresImage || 'postgres:16', redisImage: options?.redisImage || 'redis:7-alpine' },
  );
  const totalStartTime = Date.now();

  // Set test environment variables
  debugContainers.debug('[containers] Setting test environment variables');
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-secret-key-for-testing-only';
  process.env.VITE_URL = 'http://localhost:3000';

  console.log('🚀 Starting shared PostgreSQL container...');
  const pgStart = Date.now();
  sharedPostgresContainer = await startPostgresContainer(options?.postgresImage);
  const postgresUri = sharedPostgresContainer.getConnectionUri();
  (global as any)[POSTGRES_GLOBAL_KEY] = postgresUri;

  // Set database environment variables
  debugContainers.debug('[containers] Setting database environment variables');
  process.env.DB_URL = postgresUri;

  const pgElapsed = ((Date.now() - pgStart) / 1000).toFixed(2);
  debugContainers.debug('[containers] PostgreSQL setup completed in {pgElapsed}s', { pgElapsed });
  console.log(`✓ Shared PostgreSQL container started in ${pgElapsed}s`);
  console.log(`  Connection: ${postgresUri}`);

  console.log('🚀 Starting shared Redis container...');
  const redisStart = Date.now();
  sharedRedisContainer = await startRedisContainer(options?.redisImage);
  const redisHost = sharedRedisContainer.getHost();
  const redisPort = sharedRedisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  (global as any)[REDIS_GLOBAL_KEY] = redisUrl;

  // Set Redis environment variables
  debugContainers.debug('[containers] Setting Redis environment variables');
  process.env.REDIS_URL = redisUrl;
  process.env.KV_URL = redisUrl;

  const redisElapsed = ((Date.now() - redisStart) / 1000).toFixed(2);
  debugContainers.debug('[containers] Redis setup completed in {redisElapsed}s', { redisElapsed });
  console.log(`✓ Shared Redis container started in ${redisElapsed}s`);
  console.log(`  Connection: ${redisUrl}`);

  const totalElapsed = ((Date.now() - totalStartTime) / 1000).toFixed(2);
  debugContainers.debug('[containers] All shared containers setup completed in {totalElapsed}s', { totalElapsed });
  console.log(`\n✨ All shared containers started in ${totalElapsed}s`);
}

export async function teardownGlobalTestContainers(): Promise<void> {
  debugContainers.debug('[containers] Tearing down global test containers');
  console.log('🛑 Stopping shared containers...');

  // Add a delay to allow connections (main db, event store, admin) to fully close
  // Event stores use connection pools with many connections that need time to drain
  // With high _poolUseCount (48+), we need sufficient time for graceful shutdown
  // This prevents "terminating connection due to administrator command" errors
  debugContainers.debug('[containers] Waiting for connections to close...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  if (sharedPostgresContainer) {
    debugContainers.debug('[containers] Stopping PostgreSQL container');
    await sharedPostgresContainer.stop();
    sharedPostgresContainer = undefined;
    debugContainers.debug('[containers] PostgreSQL container stopped');
    console.log('✓ Shared PostgreSQL container stopped');
  } else {
    debugContainers.debug('[containers] No PostgreSQL container to stop');
  }

  if (sharedRedisContainer) {
    debugContainers.debug('[containers] Stopping Redis container');
    await sharedRedisContainer.stop();
    sharedRedisContainer = undefined;
    debugContainers.debug('[containers] Redis container stopped');
    console.log('✓ Shared Redis container stopped');
  } else {
    debugContainers.debug('[containers] No Redis container to stop');
  }

  debugContainers.debug('[containers] Clearing global connection strings');
  delete (global as any)[POSTGRES_GLOBAL_KEY];
  delete (global as any)[REDIS_GLOBAL_KEY];
  debugContainers.debug('[containers] Teardown complete');
}
