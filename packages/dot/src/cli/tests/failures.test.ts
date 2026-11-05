/** Each failure's data schema is the one source of its data type and its runtime check. */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DoctorReport, WriteFailedData } from '../failures.js';
import type { DotNewOperation } from '../json.js';
import { AppNotFound, DevPortInUse, DoctorFailed } from '../failures.js';

describe('failure data schemas', () => {
  it('accepts the right data and rejects a wrong shape', () => {
    const schema = AppNotFound.dataSchema['~standard'];
    expect(schema.validate({ cwd: '/app', searched: ['dot.config.ts'] })).toEqual({
      value: { cwd: '/app', searched: ['dot.config.ts'] },
    });
    expect(schema.validate({ cwd: '/app', searched: [1] })).toHaveProperty('issues');
    expect(schema.validate({ cwd: 3, searched: [] })).toHaveProperty('issues');
    expect(DevPortInUse.dataSchema['~standard'].validate({ port: '3000' })).toHaveProperty('issues');
  });

  it('locks the doctor and write data schemas to the hand-written public types', () => {
    expectTypeOf<Parameters<typeof DoctorFailed>[0]>().toExtend<DoctorReport>();
    expectTypeOf<DoctorReport>().toExtend<Parameters<typeof DoctorFailed>[0]>();
    expectTypeOf<WriteFailedData['written'][number]>().toExtend<DotNewOperation>();
    expectTypeOf<DotNewOperation>().toExtend<WriteFailedData['written'][number]>();
  });
});
