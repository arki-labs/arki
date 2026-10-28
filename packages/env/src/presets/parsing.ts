import { z } from 'zod';

export const parsePresets = {
  json: <T extends z.ZodType>(schema: T) =>
    z
      .string()
      .transform((str, context) => {
        try {
          return JSON.parse(str) as unknown;
        } catch {
          context.issues.push({ code: 'custom', message: 'Invalid JSON', input: str });
          return z.NEVER;
        }
      })
      .pipe(schema),

  csvArray: <T extends z.ZodType>(itemSchema: T) =>
    z.preprocess(val => {
      if (typeof val !== 'string') return val;
      return val.split(',').map(s => s.trim());
    }, z.array(itemSchema)),

  csvSet: <T extends z.ZodType>(itemSchema: T) =>
    z.preprocess(val => {
      if (typeof val !== 'string') return val;
      return [...new Set(val.split(',').map(s => s.trim()))];
    }, z.array(itemSchema)),
};
