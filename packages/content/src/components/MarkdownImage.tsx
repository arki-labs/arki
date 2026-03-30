type Props = {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
};

const MarkdownImage = ({ src, alt, width, height }: Props) => {
  if (!src || !alt) {
    throw new Error('src and alt is required');
  }
  return (
    <img
      src={src}
      alt={alt}
      width={width !== undefined ? Number(width) : undefined}
      height={height !== undefined ? Number(height) : undefined}
      className="rounded-md shadow-md"
      loading="lazy"
      decoding="async"
    />
  );
};

export default MarkdownImage;
