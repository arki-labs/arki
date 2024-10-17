import { readFileSync } from 'node:fs';
import { decode } from 'iconv-lite';

export const readFile = (pathToFile: string, encoding: string) => {
  console.debug(`Reading file ${pathToFile} with encoding ${encoding}`);
  const buffer = readFileSync(pathToFile);

  if (encoding === 'utf8') {
    return buffer.toString();
  }

  return decode(buffer, encoding);
};
