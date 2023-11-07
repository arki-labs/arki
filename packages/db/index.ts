import * as radarama from './radarama';
import * as strophie from './strophie';

export * from 'drizzle-orm';

export const getDb = (name: string) => {
  if (name === 'strophie') return strophie.db;
  if (name === 'radarama') return radarama.db;

  throw new Error(`Unknown database type: ${name}`);
};

export const getSchema = (name: string) => {
  if (name === 'strophie') return strophie.schema;
  if (name === 'radarama') return radarama.schema;

  throw new Error(`Unknown database type: ${name}`);
};

export const getTableCreator = (name: string) => {
  if (name === 'strophie') return strophie.tableCreator;
  if (name === 'radarama') return radarama.tableCreator;

  throw new Error(`Unknown database type: ${name}`);
};
