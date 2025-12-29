import { readFileSync } from 'node:fs';
import iconv from 'iconv-lite';

export const readFile = (pathToFile: string, encoding: string) => {
  console.debug(`Reading file ${pathToFile} with encoding ${encoding}`);
  const buffer = readFileSync(pathToFile);

  if (encoding === 'utf8') {
    return buffer.toString();
  }

  return iconv.decode(buffer, encoding);
};
