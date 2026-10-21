/** A plain GET form: it works without JavaScript because the browser sends `?q=` to `/errors`. */
export function ErrorSearchForm({ defaultValue }: { defaultValue: string }) {
  return (
    <form method="get" action="/errors" role="search">
      <label htmlFor="error-search">Search error codes</label>{' '}
      <input id="error-search" type="search" name="q" defaultValue={defaultValue} />{' '}
      <button type="submit">Search</button>
    </form>
  );
}
