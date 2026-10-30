type Props = {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
};

const MarkdownImage = ({ src, alt, width, height }: Props) => {
  // Markdown is authored or user text, so it must not crash the page. Without a source there is
  // nothing to show. Missing alt text is a decorative image, which is valid: `alt=""`.
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt ?? ''}
      width={width === undefined ? undefined : Number(width)}
      height={height === undefined ? undefined : Number(height)}
      className="rounded-md shadow-md"
      loading="lazy"
      decoding="async"
    />
  );
};

export default MarkdownImage;
