import type sharp from 'sharp';

// Pre-generated 8x6 gray placeholder PNG as base64
// This avoids sharp processing which can fail with certain colorspaces
const FALLBACK_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAADklEQVQI12NIS0v7////AGMB5sEJzI0AAAAASUVORK5CYII=';

const createPlaceholder = async (image: sharp.Sharp) => {
  try {
    const { width, height } = await image.metadata();
    if (!width || !height) {
      return FALLBACK_PLACEHOLDER;
    }

    const imgAspectRatio = width / height;
    const placeholderImgWidth = 8;
    const placeholderImgHeight = Math.round(placeholderImgWidth / imgAspectRatio);

    // Use jpeg output to avoid colorspace issues with png
    const buffer = await image
      .clone()
      .resize(placeholderImgWidth, placeholderImgHeight)
      .jpeg({ quality: 50 })
      .toBuffer();

    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch {
    // Return static fallback if any processing fails
    return FALLBACK_PLACEHOLDER;
  }
};

export default createPlaceholder;
