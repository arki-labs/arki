import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function readFirstLine(pathToFile: string) {
  const readable = createReadStream(pathToFile);
  const reader = createInterface({ input: readable });
  const line = await new Promise<string>(resolve => {
    reader.on('line', line => {
      reader.close();
      resolve(line);
    });
  });
  readable.close();

  return line;
}
