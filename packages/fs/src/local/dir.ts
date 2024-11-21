import path from 'node:path';

export const getParentDirName = (m: string) => {
  return path.basename(path.dirname(m));
};
