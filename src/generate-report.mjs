/**
 * image-report-action: CLI entry point.
 *
 * Reads the configuration from env, walks the images, optionally compresses them,
 * writes a single HTML file, and reports the result to GITHUB_OUTPUT.
 *
 * Principles:
 * - Zero npm dependencies. Node standard library only.
 * - Every input arrives through env (so `${{ }}` is never expanded directly into run:).
 * - When GITHUB_OUTPUT is unset, just print to stdout (so it can be run locally).
 */

import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { buildHtml, groupIntoSections, pluralize, validateReportName, walk } from './lib.mjs';
import { compressToWebp, CWEBP_SETUP_HINT, isCompressible } from './compress.mjs';

// ---------------------------------------------------------------------------
// Actions workflow commands
// ---------------------------------------------------------------------------

/**
 * Escape a workflow command message so that multi-line strings (cwebp's stderr, for
 * example) are not truncated in the annotation.
 * @param {unknown} message
 * @returns {string}
 */
function escapeCommandData(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const warn = (message) => console.log(`::warning::${escapeCommandData(message)}`);
const fail = (message) => console.log(`::error::${escapeCommandData(message)}`);

// ---------------------------------------------------------------------------
// Reading env
// ---------------------------------------------------------------------------

/**
 * Turn the strings 'true' / 'false' into a boolean. Unset or empty uses the default.
 *
 * The semantics match `inputs.x == 'true'` in action.yml (only 'true' is truthy).
 * Treating "anything but 'false'" as true would mean a value like compress: 'yes'
 * makes the bash side skip while the JS side tries to compress, producing a
 * confusing error.
 *
 * @param {string|undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseBoolean(value, defaultValue) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '') return defaultValue;
  return normalized === 'true';
}

/**
 * Read a positive integer. Throws if invalid.
 * @param {string|undefined} value
 * @param {number} defaultValue
 * @param {string} label
 * @param {number} max
 * @returns {number}
 */
function parsePositiveInt(value, defaultValue, label, max = Number.MAX_SAFE_INTEGER) {
  const raw = String(value ?? '').trim();
  if (raw === '') return defaultValue;

  // parseInt silently accepts the leading part of "90.5" or "100px", so first
  // confirm the value consists of digits only.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${label} is invalid: "${raw}" (specify an integer between 1 and ${max})`);
  }
  return parsed;
}

/**
 * Append key=value pairs to GITHUB_OUTPUT.
 *
 * Values may contain newlines, so the heredoc form is always used. The delimiter is
 * randomized like @actions/core does (a fixed EOF would break if the value contained it).
 *
 * @param {Record<string, string|number>} outputs
 */
function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;

  if (!file) {
    // When running locally, just print to stdout
    for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
    return;
  }

  const body = Object.entries(outputs)
    .map(([key, value]) => {
      const delimiter = `ghadelimiter_${randomUUID()}`;
      return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
    })
    .join('');

  appendFileSync(file, body);
}

/**
 * Warn that there are no images, write empty outputs, and bail out.
 * Shared by the "directory missing" and "no images" cases.
 * @param {string} message
 */
function skipWithNoImages(message) {
  warn(message);
  writeOutputs({ 'report-path': '', 'image-count': 0 });
}

/** Format a byte count for humans. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * Convert the compressible images in each section to WebP and return the new sections.
 *
 * Important: for compressed files only absPath is swapped for the temporary file; relPath
 * keeps the original file name (report headings and captions should show the original path).
 * That is why `mime: 'image/webp'` is passed explicitly instead of letting the MIME type be
 * inferred from relPath. Omitting it would put WebP bytes into an image/png data URI, which
 * browsers refuse to display.
 *
 * Runs sequentially. Consider parallelizing if this ever reaches ~300 images
 * (measured: 66 images, 6.9s -> 1.8s).
 *
 * @param {{dir: string, files: {absPath: string, relPath: string}[]}[]} sections
 * @param {{cwebpPath: string, tmpDir: string, width: number, quality: number}} options
 * @returns {{dir: string, files: {absPath: string, relPath: string, mime?: string}[]}[]}
 */
function compressSections(sections, { cwebpPath, tmpDir, width, quality }) {
  const total = sections.reduce((sum, section) => sum + section.files.length, 0);
  let index = 0;
  let compressed = 0;
  let skipped = 0;

  const result = sections.map((section) => ({
    dir: section.dir,
    files: section.files.map((file) => {
      index += 1;

      // Formats cwebp does not accept (svg / gif / bmp / avif) are embedded as-is
      if (!isCompressible(file.relPath)) {
        skipped += 1;
        return file;
      }

      // Output names are sequential numbers. Names derived from the basename would
      // overwrite each other when different directories hold identically named files.
      const output = join(tmpDir, `${index}.webp`);
      compressToWebp({ cwebpPath, input: file.absPath, output, width, quality });
      compressed += 1;

      if (compressed % 10 === 0 || index === total) {
        console.log(`  Compressing... ${index}/${total}`);
      }

      return { ...file, absPath: output, mime: 'image/webp' };
    }),
  }));

  console.log(`Compression done: ${compressed} converted to WebP / ${skipped} embedded as-is`);
  return result;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const rawPath = process.env.IMAGE_REPORT_PATH;
  if (!rawPath || rawPath.trim() === '') {
    throw new Error('IMAGE_REPORT_PATH (input: path) is not set.');
  }
  const rootDir = resolve(rawPath.trim());

  const reportName = (process.env.IMAGE_REPORT_NAME || 'image-report.html').trim();
  validateReportName(reportName);

  const title =
    process.env.IMAGE_REPORT_TITLE?.trim() || process.env.GITHUB_REPOSITORY || 'Image Report';
  const outputDir = resolve(
    process.env.IMAGE_REPORT_OUTPUT_DIR?.trim() || process.env.RUNNER_TEMP?.trim() || tmpdir(),
  );
  const reportPath = join(outputDir, reportName);

  // On Actions runner.temp always exists, but a local run may be given a path that has not
  // been created yet. Create it up front so the run does not fail with ENOENT after the
  // traversal and compression are already done.
  mkdirSync(outputDir, { recursive: true });

  const normalizeCaptions = parseBoolean(process.env.IMAGE_REPORT_NORMALIZE_CAPTIONS, true);
  const compress = parseBoolean(process.env.IMAGE_REPORT_COMPRESS, true);
  const compressWidth = parsePositiveInt(
    process.env.IMAGE_REPORT_COMPRESS_WIDTH,
    900,
    'compress-width',
  );
  const compressQuality = parsePositiveInt(
    process.env.IMAGE_REPORT_COMPRESS_QUALITY,
    82,
    'compress-quality',
    100,
  );

  // --- Handle the "no images" cases first ----------------------------------
  // Done before checking cwebp. Failing on a missing binary when there are no images
  // is the wrong behavior (it should exit successfully with a warning).

  let directoryExists = true;
  try {
    directoryExists = statSync(rootDir).isDirectory();
  } catch (err) {
    if (err?.code === 'ENOENT') directoryExists = false;
    else throw err;
  }

  if (!directoryExists) {
    skipWithNoImages(`Directory does not exist: ${rootDir}. Skipping report generation.`);
    return;
  }

  const files = walk(rootDir);
  console.log(`Scanned: ${rootDir} -> ${pluralize(files.length, 'image')}`);

  if (files.length === 0) {
    skipWithNoImages(`No images found: ${rootDir}. Skipping report generation.`);
    return;
  }

  let sections = groupIntoSections(files);
  console.log(`Sections: ${sections.length}`);

  // --- Compression ----------------------------------------------------------

  let tmpDir;
  try {
    if (compress) {
      const cwebpPath = process.env.IMAGE_REPORT_CWEBP_PATH?.trim();
      if (!cwebpPath) {
        throw new Error('IMAGE_REPORT_CWEBP_PATH is not set. ' + CWEBP_SETUP_HINT);
      }

      tmpDir = mkdtempSync(join(tmpdir(), 'image-report-'));
      console.log(`Compression: WebP / max width ${compressWidth}px / quality ${compressQuality}`);
      sections = compressSections(sections, {
        cwebpPath,
        tmpDir,
        width: compressWidth,
        quality: compressQuality,
      });
    } else {
      console.log('Compression: disabled (embedding the original images as-is)');
    }

    // --- Writing the report -------------------------------------------------
    // Pipe the generator into a stream so the base64 strings never all sit in memory.
    // A for..of plus write() ignores write()'s false return value, so backpressure never
    // applies and every chunk piles up in the internal buffer, defeating the streaming.
    await pipeline(
      Readable.from(buildHtml({ title, sections, normalizeCaptions })),
      createWriteStream(reportPath),
    );
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  const size = statSync(reportPath).size;
  console.log(`Generated: ${reportPath} (${formatBytes(size)} / ${pluralize(files.length, 'image')})`);

  writeOutputs({ 'report-path': reportPath, 'image-count': files.length });
}

main().catch((err) => {
  fail(err?.stack || err?.message || String(err));
  // Do not use process.exit(). stdout to a pipe is asynchronous, so progress logs would be lost.
  process.exitCode = 1;
});
