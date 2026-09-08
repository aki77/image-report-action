/**
 * image-report-action: pure functions.
 *
 * Principles:
 * - Zero npm dependencies. Node standard library only.
 * - Kept separate from the I/O layer (generate-report.mjs) so it can be unit tested with node --test.
 * - Avoid fs.globSync (Node 22+ and experimental). Hand-written recursion over readdirSync.
 */

import { openSync, readSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix as posixPath, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Extensions and MIME types
// ---------------------------------------------------------------------------

/** Fixed list of supported extensions (not configurable via inputs in v1). */
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/**
 * Return the MIME type for a file name's extension. Returns null for unsupported
 * extensions or names without one.
 * @param {string} fileName
 * @returns {string|null}
 */
export function mimeFromExtension(fileName) {
  if (typeof fileName !== 'string') return null;
  const match = /\.([^.\\/]+)$/.exec(fileName);
  if (!match) return null;
  return MIME_BY_EXTENSION[match[1].toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Reading image dimensions (no dependencies)
// ---------------------------------------------------------------------------

/** Number of bytes read for the header. JPEGs with huge EXIF/ICC data may not reach SOF, yielding null. */
const HEADER_BYTES = 65536;

/**
 * Read PNG / JPEG dimensions from the file header.
 *
 * Returns null instead of throwing when the file is unreadable, in an unsupported
 * format, or missing (callers fall back to "no resize").
 *
 * @param {string} file
 * @returns {{width: number, height: number}|null}
 */
export function imageSize(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);

    // PNG: IHDR follows \x89PNG\r\n\x1a\n (width/height are 32-bit BE)
    if (n >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: after SOI (FFD8), scan for an SOFn marker
    if (n >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o + 9 < n) {
        // Anything other than 0xFF is not the start of a marker.
        // Repeated 0xFF bytes are padding, so advance by 1 to avoid misreading them as a length.
        if (buf[o] !== 0xff || buf[o + 1] === 0xff) {
          o++;
          continue;
        }
        const m = buf[o + 1];
        // SOF0..SOF15 carry the dimensions, except DHT(C4) / JPG(C8) / DAC(CC)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + buf.readUInt16BE(o + 2);
      }
    }

    // WebP: after RIFF....WEBP, each chunk type stores the dimensions differently.
    // image/webp is in the compression targets (COMPRESSIBLE_MIMES), so failing to read
    // here would let WebP files wider than the limit through without being resized.
    if (
      n >= 30 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const chunk = buf.toString('ascii', 12, 16);
      // VP8 (lossy): the 3-byte keyframe signature 9d 01 2a is followed by 14-bit width/height
      if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      // VP8L (lossless): after the 0x2f signature, width-1 / height-1 packed in 14 bits each
      if (chunk === 'VP8L' && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      // VP8X (extended: alpha, animation, etc.): 24-bit canvas width-1 / height-1
      if (chunk === 'VP8X') {
        return {
          width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
          height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
        };
      }
    }

    return null;
  } catch {
    // ENOENT / EISDIR / EACCES etc. Swallowed: it only means the size is unavailable.
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed, etc. */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Caption formatting and sorting
// ---------------------------------------------------------------------------

/**
 * Build a caption from a file name.
 *
 * With normalize=false, returns the bare name with only the extension stripped
 * (an escape hatch when normalization mangles the name).
 *
 * @param {string} fileName
 * @param {boolean} [normalize=true]
 * @returns {string}
 */
export function normalizeCaption(fileName, normalize = true) {
  const base = String(fileName).replace(/\.[^.\\/]+$/, '');
  if (!normalize) return base;

  const normalized = base
    .replace(/^\d+[_\-.\s]+/, '') // strip a leading sequence-number prefix
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Safety net: fall back to the original if everything was stripped
  // (so a name like "001_" does not become an empty string)
  return normalized || base;
}

/**
 * Comparator for natural ordering. "2_x" < "10_x", and non-ASCII names
 * (Japanese, for example) also sort naturally.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function sortNatural(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Format a count with its noun, pluralizing the noun unless the count is 1.
 * Keeps user-facing text from reading "1 images".
 * @param {number} count
 * @param {string} noun singular form
 * @returns {string}
 */
export function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for an HTML text node. & is replaced first to avoid double escaping.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape a string for an HTML attribute value. Same as the text escape, plus " and '.
 * @param {string} str
 * @returns {string}
 */
export function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Artifact name validation
// ---------------------------------------------------------------------------

/** Characters that cannot be used in an artifact name. Matches upload-artifact's constraints. */
const FORBIDDEN_ARTIFACT_CHARS = ['"', ':', '<', '>', '|', '*', '?', '\r', '\n', '\\', '/'];

const CHAR_LABELS = { '\r': '\\r', '\n': '\\n' };

/**
 * Validate report-name (which is the artifact name itself when archive:false). Throws if invalid.
 * @param {string} name
 * @returns {void}
 */
export function validateReportName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('report-name is empty. It becomes the artifact name, so it must be at least 1 character.');
  }

  // "." and ".." contain no forbidden characters, but join(outputDir, name) resolves
  // them to a directory and the write then fails with EISDIR. Reject them explicitly here.
  if (name === '.' || name === '..') {
    throw new Error(
      `report-name "${name}" cannot be used as a file name. ` +
        'Specify a file name such as image-report.html.',
    );
  }

  const found = FORBIDDEN_ARTIFACT_CHARS.filter((c) => name.includes(c));
  if (found.length > 0) {
    const shown = found.map((c) => CHAR_LABELS[c] ?? c).join(' ');
    throw new Error(
      `report-name "${name}" contains characters that are not allowed in an artifact name: ${shown}` +
        ' (not allowed: " : < > | * ? \\r \\n \\ /).' +
        ' With archive:false the file name becomes the artifact name, so these cannot be used.',
    );
  }
}

// ---------------------------------------------------------------------------
// Directory traversal and sectioning
// ---------------------------------------------------------------------------

/**
 * Recursively walk the root directory and collect only images with supported extensions.
 *
 * - Symbolic links are not followed (prevents loops)
 * - Entries starting with a dot are skipped
 * - relPath always uses posix separators (for Windows runners)
 * - Throws if the root does not exist (handling absence is the caller's responsibility:
 *   generate-report.mjs checks with statSync beforehand and reports "directory does not exist")
 *
 * @param {string} rootDir
 * @returns {{absPath: string, relPath: string}[]}
 */
export function walk(rootDir) {
  const root = resolve(rootDir);
  /** @type {{absPath: string, relPath: string}[]} */
  const found = [];

  /** @param {string} dir */
  const visit = (dir) => {
    // Let unreadable directories throw rather than swallowing the error. Swallowing
    // ENOENT / EACCES would turn a failure into a silent "success with 0 images".
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      // Never follow symbolic links, whether they point to a directory or a file
      if (entry.isSymbolicLink()) continue;

      const absPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        visit(absPath);
      } else if (entry.isFile() && mimeFromExtension(entry.name) !== null) {
        found.push({
          absPath,
          relPath: relative(root, absPath).split(sep).join('/'),
        });
      }
    }
  };

  visit(root);
  return found;
}

/**
 * Group images into sections, one per directory that directly contains images.
 *
 * Images directly under the root get dir === ".". Both sections and files are sorted naturally.
 *
 * @param {{absPath: string, relPath: string}[]} files
 * @returns {{dir: string, files: {absPath: string, relPath: string}[]}[]}
 */
export function groupIntoSections(files) {
  /** @type {Map<string, {absPath: string, relPath: string}[]>} */
  const byDir = new Map();

  for (const file of files) {
    const dir = posixPath.dirname(file.relPath);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(file);
    else byDir.set(dir, [file]);
  }

  return [...byDir.keys()]
    .sort((a, b) => {
      // The root section (".") always comes first; do not rely on how symbols collate.
      if (a === b) return 0;
      if (a === '.') return -1;
      if (b === '.') return 1;
      return sortNatural(a, b);
    })
    .map((dir) => ({
      dir,
      files: byDir.get(dir).sort((a, b) => sortNatural(a.relPath, b.relPath)),
    }));
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

/** Display name for a section heading. The root section is shown as "(root)". */
function sectionLabel(dir) {
  return dir === '.' ? '(root)' : dir;
}

const STYLES = `
:root { --w: 240px; --ratio: 3 / 4; --fg: #24292f; --muted: #57606a; --bg: #ffffff; --line: #d0d7de; --thumb-bg: #f6f8fa; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  line-height: 1.6; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.meta { color: var(--muted); font-size: .875rem; margin: 0 0 24px; }
.toc { background: var(--thumb-bg); border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; }
.toc h2 { font-size: .875rem; margin: 0 0 8px; border: 0; padding: 0; font-family: inherit; color: var(--muted); }
.toc ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 16px; }
.toc a { color: #0969da; text-decoration: none; font-size: .875rem; word-break: break-all; }
.toc a:hover { text-decoration: underline; }
.count { color: var(--muted); font-weight: normal; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--w), 1fr)); gap: 16px; }
figure { margin: 0; }
.thumb { aspect-ratio: var(--ratio); display: grid; place-items: center; overflow: hidden;
  background: var(--thumb-bg); border: 1px solid var(--line); border-radius: 6px;
  cursor: zoom-in; padding: 0; width: 100%; }
.thumb img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
figcaption { font-size: .8125rem; margin-top: 6px; word-break: break-all; }
figcaption .path { display: block; color: var(--muted); font-size: .6875rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
dialog { max-width: 96vw; max-height: 96vh; padding: 0; border: 0; border-radius: 6px;
  background: transparent; overflow: visible; }
dialog:focus, dialog:focus-visible { outline: none; }
dialog::backdrop { background: rgba(0, 0, 0, .8); }
dialog img { display: block; max-width: 96vw; max-height: 88vh; object-fit: contain;
  border-radius: 6px; background: var(--thumb-bg); }
dialog .path { display: block; margin-top: 8px; color: #fff; font-size: .75rem; text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.empty { color: var(--muted); }
`.trim();

// No user-supplied string is ever embedded here (to avoid any escaping issues).
const SCRIPT = `
const dlg = document.getElementById('lightbox');
const dlgImg = dlg.querySelector('img');
const dlgPath = dlg.querySelector('.path');
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.thumb');
  if (!btn) return;
  const img = btn.querySelector('img');
  dlgImg.src = img.src;
  dlgImg.alt = img.alt;
  dlgPath.textContent = btn.dataset.path;
  dlg.showModal();
});
dlg.addEventListener('close', () => { dlgImg.removeAttribute('src'); });
// light-dismiss fallback for browsers without closedby support (Safari, etc.)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
`.trim();

/**
 * Build a data URI.
 * @param {string} mime
 * @param {Buffer} buffer
 * @returns {string}
 */
function dataUri(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Synchronous generator that yields the report HTML chunk by chunk.
 *
 * It does not return one big string so that the base64 payloads never all sit in memory
 * at once. Callers should write it out with backpressure, as in
 * `pipeline(Readable.from(buildHtml(...)), createWriteStream(out))` (a `for..of` plus
 * `stream.write()` that ignores a false return value lets every chunk pile up in the
 * internal buffer, defeating the point of streaming).
 *
 * @param {object} options
 * @param {string} options.title report heading
 * @param {{dir: string, files: {absPath: string, relPath: string, mime?: string}[]}[]} options.sections
 * @param {boolean} [options.normalizeCaptions=true]
 * @param {(absPath: string) => Buffer} [options.readFile] image reader (replaceable in tests)
 * @yields {string} a chunk of HTML
 */
export function* buildHtml({ title, sections, normalizeCaptions = true, readFile = readFileSync }) {
  const imageCount = sections.reduce((sum, s) => sum + s.files.length, 0);

  yield `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLES}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${pluralize(imageCount, 'image')} / ${pluralize(sections.length, 'section')}</p>
`;

  // Table of contents (section name + count). Anchor ids are index-based, because ids
  // derived from directory names (non-ASCII, spaces, "/") break when the href is encoded.
  if (sections.length > 0) {
    yield '<nav class="toc">\n<h2>Contents</h2>\n<ul>\n';
    for (const [i, section] of sections.entries()) {
      yield `<li><a href="#sec-${i}">${escapeHtml(sectionLabel(section.dir))}</a>` +
        ` <span class="count">(${section.files.length})</span></li>\n`;
    }
    yield '</ul>\n</nav>\n';
  } else {
    yield '<p class="empty">No images found.</p>\n';
  }

  for (const [i, section] of sections.entries()) {
    const label = sectionLabel(section.dir);
    yield `<section>\n<h2 id="sec-${i}">${escapeHtml(label)}` +
      ` <span class="count">(${section.files.length})</span></h2>\n<div class="grid">\n`;

    for (const file of section.files) {
      const mime = file.mime ?? mimeFromExtension(file.relPath) ?? 'application/octet-stream';
      const fileName = posixPath.basename(file.relPath);
      const caption = normalizeCaption(fileName, normalizeCaptions);
      // Even when normalized, always keep the original relative path in the title
      // attribute and the monospace subtitle
      const relAttr = escapeAttr(file.relPath);
      const src = dataUri(mime, readFile(file.absPath));

      yield `<figure>
<button type="button" class="thumb" data-path="${relAttr}" title="${relAttr}">
<img src="${src}" alt="${escapeAttr(caption)}" loading="lazy" decoding="async">
</button>
<figcaption title="${relAttr}">${escapeHtml(caption)}<span class="path">${escapeHtml(file.relPath)}</span></figcaption>
</figure>
`;
    }

    yield '</div>\n</section>\n';
  }

  yield `<dialog id="lightbox" closedby="any" aria-label="Enlarged view">
<img alt="">
<span class="path"></span>
</dialog>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}
