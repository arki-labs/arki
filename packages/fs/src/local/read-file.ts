import { readFileSync } from 'node:fs';

import { decode } from 'iconv-lite';

export const readFile = (pathToFile: string, encoding: string) => {
  const buffer = readFileSync(pathToFile);

  return decode(buffer, encoding);
};
