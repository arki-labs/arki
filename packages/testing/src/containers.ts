import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

export const POSTGRES_GLOBAL_KEY = '__POSTGRES_CONNECTION_STRING__';
export const REDIS_GLOBAL_KEY = '__REDIS_CONNECTION_STRING__';

export interface SharedContainerOptions {
  postgresImage?: string;
  redisImage?: string;
}

let sharedPostgresContainer: StartedPostgreSqlContainer | undefined;
let sharedRedisContainer: StartedTestContainer | undefined;

export async function startPostgresContainer(image = 'postgres:16'): Promise<StartedPostgreSqlContainer> {
  return await new PostgreSqlContainer(image).withDatabase('test').withUsername('test').withPassword('test').start();
}

export async function startRedisContainer(image = 'redis:7-alpine'): Promise<StartedTestContainer> {
  return await new GenericContainer(image).withExposedPorts(6379).start();
}

export function getGlobalPostgresConnectionString(): string | undefined {
  return (global as any)[POSTGRES_GLOBAL_KEY];
}

export function getGlobalRedisConnectionString(): string | undefined {
  return (global as any)[REDIS_GLOBAL_KEY];
}

export async function setupGlobalTestContainers(options?: SharedContainerOptions): Promise<void> {
  const totalStartTime = Date.now();

  console.log('🚀 Starting shared PostgreSQL container...');
  const pgStart = Date.now();
  sharedPostgresContainer = await startPostgresContainer(options?.postgresImage);
  const postgresUri = sharedPostgresContainer.getConnectionUri();
  (global as any)[POSTGRES_GLOBAL_KEY] = postgresUri;
  console.log(`✓ Shared PostgreSQL container started in ${((Date.now() - pgStart) / 1000).toFixed(2)}s`);
  console.log(`  Connection: ${postgresUri}`);

  console.log('🚀 Starting shared Redis container...');
  const redisStart = Date.now();
  sharedRedisContainer = await startRedisContainer(options?.redisImage);
  const redisHost = sharedRedisContainer.getHost();
  const redisPort = sharedRedisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  (global as any)[REDIS_GLOBAL_KEY] = redisUrl;
  console.log(`✓ Shared Redis container started in ${((Date.now() - redisStart) / 1000).toFixed(2)}s`);
  console.log(`  Connection: ${redisUrl}`);

  console.log(`\n✨ All shared containers started in ${((Date.now() - totalStartTime) / 1000).toFixed(2)}s`);
}

export async function teardownGlobalTestContainers(): Promise<void> {
  console.log('🛑 Stopping shared containers...');

  if (sharedPostgresContainer) {
    await sharedPostgresContainer.stop();
    sharedPostgresContainer = undefined;
    console.log('✓ Shared PostgreSQL container stopped');
  }

  if (sharedRedisContainer) {
    await sharedRedisContainer.stop();
    sharedRedisContainer = undefined;
    console.log('✓ Shared Redis container stopped');
  }

  delete (global as any)[POSTGRES_GLOBAL_KEY];
  delete (global as any)[REDIS_GLOBAL_KEY];
}
