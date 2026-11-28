import sharp from 'sharp';

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export async function encodeAccountAvatar(
  upload: unknown,
): Promise<string | null> {
  if (
    !(upload instanceof File) ||
    upload.size === 0 ||
    upload.size > MAX_AVATAR_BYTES
  )
    return null;
  const bytes = Buffer.from(await upload.arrayBuffer());
  const isJpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp =
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return null;

  try {
    const image = await sharp(bytes, { limitInputPixels: 16_000_000 })
      .autoOrient()
      .resize(128, 128, { fit: 'cover' })
      .webp({ quality: 78 })
      .toBuffer();
    return image.length <= 18_000 ? image.toString('base64') : null;
  } catch {
    return null;
  }
}
