/** pg-boss requires a UUID; external job keys stay opaque and are scoped to the job queue. */
import { v5 } from 'uuid';

export function pgBossJobId(name: string, key: string): string {
  return v5(JSON.stringify([name, key]), v5.URL);
}
