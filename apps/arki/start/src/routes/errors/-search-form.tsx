/** A plain GET form: it works without JavaScript because the browser sends `?q=` to `/errors`. */
export function ErrorSearchForm({ defaultValue, mono = false }: { defaultValue: string; mono?: boolean }) {
  return (
    <form method="get" action="/errors" role="search" aria-label="Search error codes" className="esearch">
      <label htmlFor="error-search" className="sr">
        Search error codes
      </label>
      <div className={mono ? 'esearch-box mono' : 'esearch-box'}>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          id="error-search"
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder="Code, package or words, e.g. timeout"
        />
      </div>
      <button type="submit" className="btn">
        Search
      </button>
    </form>
  );
}
