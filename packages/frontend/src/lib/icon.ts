// Minecraft shows server-icon.png at 64 x 64 pixels. Any picture the user chooses is cut to a square from its
// middle and scaled to that size in the browser, so the server receives exactly what Minecraft expects.
export const ICON_SIZE = 64;
export const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

// Decoded straight from the file: an <img> with a blob: address would be blocked by the Content-Security-Policy
// (img-src allows only the application itself and the mod sites).
export async function toServerIcon(file: Blob): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const side = Math.min(image.width, image.height);
    if (side === 0) throw new Error('image');
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('canvas')) : resolve(blob)), 'image/png'));
  } finally {
    image.close();
  }
}
