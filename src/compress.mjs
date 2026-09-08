/**
 * image-report-action: image compression via cwebp.
 *
 * Principles:
 * - Zero npm dependencies. Node standard library only.
 * - **Downloading and extracting the binary does not happen here** (that is the job of the
 *   bash step in action.yml). This module only runs the executable path it is given, via execFileSync.
 * - Never go through a shell (so paths containing spaces or non-ASCII characters are passed safely).
 * - On failure, stop with a clear error instead of falling back to the raw file
 *   (output silently changing depending on the runner is the worst possible behavior).
 */

import { execFileSync } from 'node:child_process';

import { imageSize, mimeFromExtension } from './lib.mjs';

/**
 * MIME types cwebp accepts as input.
 * gif / svg / bmp / avif are unsupported, so the caller embeds them as-is.
 *
 * The check is on the MIME type rather than the extension itself so that the list of
 * supported extensions lives in one place, MIME_BY_EXTENSION in lib.mjs (listing an
 * extension here that the traversal never picks up would just be unreachable dead code).
 */
const COMPRESSIBLE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Determine from the extension whether a file can be passed to cwebp (case-insensitive).
 * @param {string} fileName
 * @returns {boolean}
 */
export function isCompressible(fileName) {
  return COMPRESSIBLE_MIMES.includes(mimeFromExtension(fileName));
}

/**
 * Guidance shown when cwebp is unavailable. Shared so that compress.mjs and
 * generate-report.mjs print the same message.
 */
export const CWEBP_SETUP_HINT =
  'The binary setup step in action.yml (download, sha256 verification, extraction) may have failed. ' +
  'Set compress: false to generate the report without compression.';

/**
 * Convert a single image to WebP. Throws on failure.
 *
 * Preventing upscaling: `cwebp -resize <w> 0` is not an upper bound, it forces the width to
 * that value, so passing it a smaller image enlarges it (measured: 300x200 -> 900x600).
 * Upscaling both degrades quality and increases file size (measured: +25%), so the flag is
 * only passed when the source is wider than width. When the size cannot be read
 * (imageSize returns null), the image is passed through without resizing rather than failing.
 *
 * @param {object} options
 * @param {string} options.cwebpPath path to the cwebp executable
 * @param {string} options.input path to the input image
 * @param {string} options.output path of the .webp file to write
 * @param {number} options.width maximum width after downscaling
 * @param {number} options.quality cwebp's -q (0-100)
 * @returns {string} output (returned so callers can chain easily)
 */
export function compressToWebp({ cwebpPath, input, output, width, quality }) {
  const sourceWidth = imageSize(input)?.width;
  const resize = sourceWidth && sourceWidth > width ? ['-resize', String(width), '0'] : [];

  const args = ['-quiet', '-q', String(quality), ...resize, input, '-o', output];

  try {
    // Do not use shell: true. Passing the argument array directly removes the need for
    // quoting and makes injection impossible.
    execFileSync(cwebpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // The binary itself is missing or cannot be executed
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') {
      throw new Error(`Failed to run cwebp (${err.code}): ${cwebpPath}\n` + CWEBP_SETUP_HINT);
    }

    // cwebp started but the conversion failed
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    throw new Error(
      `cwebp failed (exit ${err?.status ?? '?'}): ${input}\n` +
        `Command: ${cwebpPath} ${args.join(' ')}` +
        (stderr ? `\ncwebp stderr:\n${stderr}` : ''),
    );
  }

  return output;
}
