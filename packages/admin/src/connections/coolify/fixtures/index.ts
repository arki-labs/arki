/** Synthetic fixtures shaped from coolify.io/docs/api-reference. No real instance data. */
export const APP_UUID = 'app00000example';
export const DEPLOY_UUID = 'dep00000example';
export const SERVER_UUID = 'srv00000example';
export const PROJECT_UUID = 'prj00000example';

export const applications = [
  {
    id: 1,
    uuid: APP_UUID,
    name: 'example-web',
    fqdn: 'https://example.invalid',
    status: 'running:healthy',
    git_repository: 'example/repo',
    git_branch: 'main',
    git_commit_sha: 'abc1234',
    build_pack: 'nixpacks',
    updated_at: '2026-01-02T03:04:05.000000Z',
    environment_id: 3,
    base_directory: '/',
    dockerfile_location: '/apps/example/Dockerfile',
    docker_compose_location: '/docker-compose.yaml',
    watch_paths: 'apps/example/**',
    settings: { is_static: false },
    future_field: 'tolerated',
  },
];

export const deployment = {
  id: 7,
  application_id: '1',
  deployment_uuid: DEPLOY_UUID,
  status: 'failed',
  application_name: 'example-web',
  server_name: 'example-server',
  commit: 'abc1234',
  commit_message: 'example change',
  deployment_url: '/project/x/deployment/dep00000example',
  created_at: '2026-01-02 03:00:00',
  updated_at: '2026-01-02 03:04:05',
};

export const servers = [
  {
    id: 1,
    uuid: SERVER_UUID,
    name: 'example-server',
    ip: '192.0.2.10',
    settings: { is_reachable: true, is_usable: true },
  },
];

export const projects = [{ id: 2, uuid: PROJECT_UUID, name: 'Example', description: null }];

export const environments = [
  { id: 3, name: 'production', project_id: 2, created_at: '2026-01-02T03:04:05.000000Z', description: null },
];

export const unreachableServer = { ...servers[0], settings: { is_reachable: false, is_usable: false } };
