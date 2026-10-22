/** The four letters of the arki wordmark. They take the surrounding `fill`. */
function Letters() {
  return (
    <>
      <path d="M62.4 350V287.8C62.4 251.8 92.4 223.3 131.1 223.3C169.7 223.3 198.8 251.8 198.8 287.8V350H159.5V290.5C159.5 275.8 147 265.5 131 265.5C114.8 265.5 100.4 276.1 100.4 291V305.4C117.5 307.2 130.4 320.5 130.4 338.7V350Z" />
      <path d="M206.3 350V288.5C206.3 251.2 232.8 221.7 269.7 223.8V264C254.2 263.6 244.2 276.9 244.2 291.1V350Z" />
      <path d="M277.3 191.5H317V270L353.5 230.5H403.7L347.9 290.1L403.3 350H353.7L317 311.4V350H277.3Z" />
      <path d="M408.7 230.5H449V350H408.7Z" />
    </>
  );
}

/** The wordmark with its accent dot, for the header and footer. */
export function Wordmark() {
  return (
    <svg className="home-wordmark" viewBox="42 135 430 234" aria-hidden="true">
      <Letters />
      <circle className="home-wordmark-dot" cx="421.5" cy="187" r="32.5" />
    </svg>
  );
}

/** Only the accent dot, for the header of pages whose hero already shows the letters. */
export function BrandDot() {
  return (
    <svg className="home-brand-dot" viewBox="389 154.5 65 65" aria-hidden="true">
      <circle className="home-wordmark-dot" cx="421.5" cy="187" r="32.5" />
    </svg>
  );
}

/** The hero wordmark: the bubble sits where the dot is, over a soft glow. */
export function HeroMark() {
  return (
    <svg className="home-hero-mark" viewBox="42 135 430 234" role="img" aria-label="arki">
      <defs>
        <radialGradient id="home-hero-glow">
          <stop offset=".45" className="home-glow-core" />
          <stop offset="1" className="home-glow-edge" />
        </radialGradient>
      </defs>
      <Letters />
      <circle cx="421.5" cy="187" r="46" fill="url(#home-hero-glow)" />
      <g className="home-drift">
        <image href="/assets/elevation/bubble.webp" x="377.5" y="143" width="88" height="88" />
      </g>
    </svg>
  );
}
