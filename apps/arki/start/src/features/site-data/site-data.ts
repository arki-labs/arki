import { createServerFn } from '@tanstack/react-start';

import { z } from '@arki/contracts';

import {
  findError,
  findGuide,
  findPackage,
  findPackageDoc,
  getDotNew,
  listDemos,
  listErrors,
  listExamples,
  listGuides,
  listPackageDocs,
  listPackages,
  readApiIndex,
  readSnapshotFile,
  SNAPSHOT_RAW_FILES,
} from './site-data.server';

/**
 * Server functions over the site's data. Routes call these from loaders; the data, its schemas and the compiled
 * docs stay on the server. A `null` result means unknown: throw `notFound()`.
 */

const snapshotInput = z.object({ short: z.string(), version: z.string() });

export const listPackagesFn = createServerFn({ method: 'GET' }).handler(() => listPackages());

export const getPackageFn = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ short: z.string() }))
  .handler(({ data }) => findPackage(data.short));

export const listPackageDocsFn = createServerFn({ method: 'GET' })
  .inputValidator(snapshotInput)
  .handler(({ data }) => listPackageDocs(data.short, data.version));

export const getPackageDocFn = createServerFn({ method: 'GET' })
  .inputValidator(snapshotInput.extend({ path: z.string() }))
  .handler(({ data }) => findPackageDoc(data.short, data.version, data.path));

export const getSnapshotFileFn = createServerFn({ method: 'GET' })
  .inputValidator(snapshotInput.extend({ file: z.enum(SNAPSHOT_RAW_FILES) }))
  .handler(({ data }) => readSnapshotFile(data.short, data.version, data.file));

export const getApiIndexFn = createServerFn({ method: 'GET' })
  .inputValidator(snapshotInput)
  .handler(({ data }) => readApiIndex(data.short, data.version));

export const listErrorsFn = createServerFn({ method: 'GET' }).handler(() => listErrors());

export const getErrorFn = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ code: z.string() }))
  .handler(({ data }) => findError(data.code));

export const listExamplesFn = createServerFn({ method: 'GET' }).handler(() => listExamples());

export const listDemosFn = createServerFn({ method: 'GET' }).handler(() => listDemos());

export const getDotNewFn = createServerFn({ method: 'GET' }).handler(() => getDotNew());

export const listGuidesFn = createServerFn({ method: 'GET' }).handler(() => listGuides());

export const getGuideFn = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ slug: z.string() }))
  .handler(({ data }) => findGuide(data.slug));
