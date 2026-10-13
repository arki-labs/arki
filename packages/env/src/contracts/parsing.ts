import { z } from 'zod';

export const parseContracts = {
  json: <T extends z.ZodType>(schema: T) =>
    z.string().transform((str) => {
      const parsed = JSON.parse(str);
      return schema.parse(parsed) as z.infer<T>;
    }),

  csvArray: <T extends z.ZodType>(itemSchema: T) =>
    z.preprocess(
      (val) => {
        if (typeof val !== 'string') return val;
        return val.split(',').map((s) => s.trim());
      },
      z.array(itemSchema)
    ),

  csvSet: <T extends z.ZodType>(itemSchema: T) =>
    z.preprocess(
      (val) => {
        if (typeof val !== 'string') return val;
        return [...new Set(val.split(',').map((s) => s.trim()))];
      },
      z.array(itemSchema)
    ),
};
