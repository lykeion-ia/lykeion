/**
 * Turning a picked file into the data URL `setAvatar` accepts.
 *
 * The contract caps a profile picture at `MAX_AVATAR_BYTES`, which almost
 * nothing off a phone or a camera meets. Rather than refuse those and make the
 * cap the person's problem, the picture is decoded here and redrawn at
 * `AVATAR_EDGE`, which is what a 64px circle needs on a 2× display with room to
 * spare. The cap is then a backstop nobody normally meets rather than a rule
 * they have to work around.
 */

/** The square edge every uploaded picture is redrawn at, in device pixels. */
export const AVATAR_EDGE = 256;

/** JPEG quality for the redrawn square. High enough that a face at 64px shows
 *  no artefacts, low enough that the result lands far under the contract's cap. */
const QUALITY = 0.85;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("that file could not be read — try a different one"));
    reader.readAsDataURL(file);
  });
}

/**
 * A picked file as a square data URL ready for `setAvatar`.
 *
 * Cover-cropped, not letterboxed: a portrait photo in a circular frame should
 * fill it the way every other avatar does, and bars inside the circle would
 * make one person's face render differently from everyone else's.
 *
 * Where the platform cannot decode an image — a test environment, chiefly —
 * the file's own bytes are returned unchanged. That keeps this function honest
 * about what it did rather than failing, and an original too large for the cap
 * is then refused by the contract with a message that says so.
 */
export async function toAvatarDataUrl(file: Blob): Promise<string> {
  const raw = await readAsDataUrl(file);
  if (typeof createImageBitmap !== "function") return raw;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not a picture this platform can decode. Hand back what was picked and
    // let the contract's own check name the problem.
    return raw;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE;
    canvas.height = AVATAR_EDGE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;

    // The largest centred square the source contains, drawn to fill the frame.
    const edge = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(
      bitmap,
      (bitmap.width - edge) / 2,
      (bitmap.height - edge) / 2,
      edge,
      edge,
      0,
      0,
      AVATAR_EDGE,
      AVATAR_EDGE,
    );
    return canvas.toDataURL("image/jpeg", QUALITY);
  } finally {
    bitmap.close();
  }
}
