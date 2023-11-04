import * as strophie from './strophie';

export * from 'drizzle-orm';

export const getDb = (name: string) => {
  if (name === 'strophie') return strophie.db;

  throw new Error(`Unknown database type: ${name}`);
};

export const getSchema = (name: string) => {
  if (name === 'strophie') return strophie.schema;

  throw new Error(`Unknown database type: ${name}`);
};

export const getTableCreator = (name: string) => {
  if (name === 'strophie') return strophie.tableCreator;

  throw new Error(`Unknown database type: ${name}`);
};

export { strophie };
