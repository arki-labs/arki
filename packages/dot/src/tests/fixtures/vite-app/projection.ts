/** The `routes` projection of the fixture app: manifest in, JSON document out. */
import type { DotAppManifest } from '../../../manifest.js';

export function project(manifest: DotAppManifest): { readonly app: string; readonly plugins: readonly string[] } {
  return { app: manifest.app.name, plugins: manifest.plugins.map(entry => entry.name) };
}
