export * from 'drizzle-orm';
// `relations()` and the relations-helper types moved to a subpath in drizzle-orm 1.0.
export { relations } from 'drizzle-orm/_relations';
// `drizzle-orm/zod` replaces the standalone drizzle-zod package in 1.0.
// Named re-export prevents an IsNever collision with drizzle-orm's main types.
export {
  createInsertSchema,
  createSchemaFactory,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-orm/zod';
