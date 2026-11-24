// Minecraft shows server-icon.png at 64 x 64 pixels. Any picture the user chooses is cut to a square from its
// middle and scaled to that size in the browser, so the server receives exactly what Minecraft expects.
export const ICON_SIZE = 64;
export const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    image.src = url;
  });
}

export async function toServerIcon(file: Blob): Promise<Blob> {
  const image = await loadImage(file);
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (side === 0) throw new Error('image');
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('canvas')) : resolve(blob)), 'image/png'));
}
