import { z } from 'zod';

/**
 * Response schemas for the Coolify v4 REST API (`/api/v1`). Each one lists only the fields
 * Foreman reads. Unknown extra fields are tolerated; a missing required field fails the read.
 */

const nullableString = z.string().nullish();

export const coolifyApplicationSchema = z.looseObject({
  uuid: z.string().min(1),
  name: z.string(),
  status: z.string().optional(),
  fqdn: nullableString,
  git_repository: nullableString,
  git_branch: nullableString,
  git_commit_sha: nullableString,
  build_pack: nullableString,
  updated_at: nullableString,
  /** Joins to {@link coolifyEnvironmentSchema}'s `id`, which names the project. */
  environment_id: z.number().int().nullish(),
  /** Where the build runs, from the repository root (`/micro/scraper`). */
  base_directory: nullableString,
  /** The Dockerfile, relative to `base_directory` (`/apps/web/start/Dockerfile`). */
  dockerfile_location: nullableString,
  docker_compose_location: nullableString,
  /** Paths whose change triggers a deploy, one pattern per line. */
  watch_paths: nullableString,
});

export const coolifyProjectSchema = z.looseObject({
  id: z.number().int(),
  uuid: z.string().min(1),
  name: z.string(),
});

export const coolifyEnvironmentSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  project_id: z.number().int(),
});

export const coolifyDeploymentSchema = z.looseObject({
  deployment_uuid: z.string().min(1),
  status: z.string(),
  application_id: z.union([z.string(), z.number()]).nullish(),
  application_name: nullableString,
  server_name: nullableString,
  commit: nullableString,
  commit_message: nullableString,
  deployment_url: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
});

/** Coolify returns either a bare array or `{ count, deployments }` depending on the version. */
export const coolifyDeploymentListSchema = z.union([
  z.array(coolifyDeploymentSchema),
  z.looseObject({ deployments: z.array(coolifyDeploymentSchema) }).transform(v => v.deployments),
]);

export const coolifyServerSchema = z.looseObject({
  uuid: z.string().min(1),
  name: z.string(),
  ip: nullableString,
  settings: z
    .looseObject({
      is_reachable: z.boolean().nullish(),
      is_usable: z.boolean().nullish(),
    })
    .nullish(),
});

export const coolifyApplicationListSchema = z.array(coolifyApplicationSchema);
export const coolifyServerListSchema = z.array(coolifyServerSchema);
export const coolifyProjectListSchema = z.array(coolifyProjectSchema);
export const coolifyEnvironmentListSchema = z.array(coolifyEnvironmentSchema);

export type CoolifyApplication = z.infer<typeof coolifyApplicationSchema>;
export type CoolifyDeployment = z.infer<typeof coolifyDeploymentSchema>;
export type CoolifyServer = z.infer<typeof coolifyServerSchema>;
export type CoolifyProject = z.infer<typeof coolifyProjectSchema>;
export type CoolifyEnvironment = z.infer<typeof coolifyEnvironmentSchema>;
