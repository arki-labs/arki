/** Insert-ordered bounded memo: when `limit` is reached the oldest entry is dropped. */
export function remember<V>(cache: Map<string, V>, key: string, limit: number, create: () => V): V {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const created = create();
  if (cache.size >= limit) {
    const oldest = cache.keys().next();
    // eslint-disable-next-line drizzle/enforce-delete-with-where -- Map#delete, not a Drizzle query
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, created);
  return created;
}
