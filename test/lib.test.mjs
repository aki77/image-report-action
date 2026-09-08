import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  imageSize,
  normalizeCaption,
  sortNatural,
  pluralize,
  mimeFromExtension,
  escapeHtml,
  escapeAttr,
  validateReportName,
  walk,
  groupIntoSections,
  buildHtml,
} from '../src/lib.mjs';

// ---------------------------------------------------------------------------
// Byte builders for the tests (no fixture files needed)
// ---------------------------------------------------------------------------

/** Minimal PNG header. imageSize only looks at IHDR, so CRCs and chunk bodies are unnecessary. */
function pngBytes(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * Minimal JPEG: SOI -> APP0 (with a length, to exercise segment skipping) -> SOF0.
 * When padBeforeSof is true, 0xFF padding is inserted right before the SOF marker.
 */
function jpegBytes(width, height, { padBeforeSof = false } = {}) {
  const parts = [
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x10]), // APP0, length 16
    Buffer.alloc(14), // APP0 payload (length 16 - 2)
  ];
  if (padBeforeSof) parts.push(Buffer.from([0xff, 0xff, 0xff]));

  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1); // SOF0
  sof.writeUInt16BE(17, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.alloc(20)); // trailing slack so the scan loop keeps satisfying o+9<n

  return Buffer.concat(parts);
}

/** Temporary directory shared by the whole test run. */
let tmpRoot;
before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'image-report-test-'));
});
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Assemble a minimal WebP: a RIFF container holding a single chunk. */
function webpContainer(chunkId, payload) {
  const body = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    Buffer.from(chunkId, 'ascii'),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(payload.length, 0);
      return b;
    })(),
    payload,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, body]);
}

/** VP8 (lossy): the 9d 01 2a signature followed by 14-bit width and height. */
function webpVp8(width, height) {
  const payload = Buffer.alloc(20);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return webpContainer('VP8 ', payload);
}

/** VP8L (lossless): 0x2f followed by width-1 and height-1 packed as 14 bits each. */
function webpVp8l(width, height) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((height - 1) << 14) | (width - 1), 1);
  return webpContainer('VP8L', payload);
}

/** VP8X (extended): 24-bit canvas width-1 and height-1. */
function webpVp8x(width, height) {
  const payload = Buffer.alloc(10);
  const w = width - 1;
  const h = height - 1;
  payload[4] = w & 0xff;
  payload[5] = (w >> 8) & 0xff;
  payload[6] = (w >> 16) & 0xff;
  payload[7] = h & 0xff;
  payload[8] = (h >> 8) & 0xff;
  payload[9] = (h >> 16) & 0xff;
  return webpContainer('VP8X', payload);
}


function writeTmp(relPath, content) {
  const abs = join(tmpRoot, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** A file entry for groupIntoSections / buildHtml (no real file on disk needed). */
const mk = (relPath) => ({ absPath: `/abs/${relPath}`, relPath });

// ---------------------------------------------------------------------------

describe('normalizeCaption', () => {
  test('strips the leading sequence number and turns underscores into spaces', () => {
    assert.equal(normalizeCaption('001_visit_foo.png'), 'visit foo');
  });

  test('strips the sequence number when the separator is -, . or a space', () => {
    assert.equal(normalizeCaption('12-step_one.jpg'), 'step one');
    assert.equal(normalizeCaption('3. title.png'), 'title');
  });

  test('collapses runs of whitespace into one and trims', () => {
    assert.equal(normalizeCaption('01__a___b__.png'), 'a b');
  });

  test('returns the bare name without its extension when normalize is false', () => {
    assert.equal(normalizeCaption('001_visit_foo.png', false), '001_visit_foo');
  });

  test('does not blank out an all-digit file name (the pattern does not match)', () => {
    assert.equal(normalizeCaption('123.png'), '123');
  });

  test('falls back to the original file name when everything would be stripped', () => {
    assert.equal(normalizeCaption('001_.png'), '001_');
    assert.equal(normalizeCaption('42-.png'), '42-');
  });

  test('works on names without an extension', () => {
    assert.equal(normalizeCaption('README'), 'README');
  });
});

describe('sortNatural', () => {
  test('orders 2_x before 10_x (numeric)', () => {
    assert.ok(sortNatural('2_x', '10_x') < 0);
    assert.deepEqual(['10_x', '2_x', '1_x'].sort(sortNatural), ['1_x', '2_x', '10_x']);
  });

  test('compares Japanese (hiragana) in natural order', () => {
    assert.ok(sortNatural('あ', 'い') < 0);
    assert.deepEqual(['う', 'あ', 'い'].sort(sortNatural), ['あ', 'い', 'う']);
  });
});

describe('pluralize', () => {
  test('does not pluralize a count of 1', () => {
    assert.equal(pluralize(1, 'image'), '1 image');
    assert.equal(pluralize(1, 'section'), '1 section');
  });

  test('pluralizes 0 and counts above 1', () => {
    assert.equal(pluralize(0, 'image'), '0 images');
    assert.equal(pluralize(7, 'image'), '7 images');
  });
});

describe('mimeFromExtension', () => {
  test('returns the right MIME type for every supported extension', () => {
    assert.equal(mimeFromExtension('a.png'), 'image/png');
    assert.equal(mimeFromExtension('a.jpg'), 'image/jpeg');
    assert.equal(mimeFromExtension('a.jpeg'), 'image/jpeg');
    assert.equal(mimeFromExtension('a.gif'), 'image/gif');
    assert.equal(mimeFromExtension('a.webp'), 'image/webp');
    assert.equal(mimeFromExtension('a.avif'), 'image/avif');
    assert.equal(mimeFromExtension('a.svg'), 'image/svg+xml');
    assert.equal(mimeFromExtension('a.bmp'), 'image/bmp');
  });

  test('recognizes uppercase extensions', () => {
    assert.equal(mimeFromExtension('A.PNG'), 'image/png');
    assert.equal(mimeFromExtension('A.JPEG'), 'image/jpeg');
  });

  test('returns null for unknown extensions and for names without one', () => {
    assert.equal(mimeFromExtension('a.txt'), null);
    assert.equal(mimeFromExtension('a.mp4'), null);
    assert.equal(mimeFromExtension('README'), null);
  });

  test('looks at the file name, not a dot in a directory name', () => {
    assert.equal(mimeFromExtension('dir.v1/README'), null);
  });
});

describe('escapeHtml / escapeAttr', () => {
  test('escapeHtml escapes &, < and >', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });

  test('escapeHtml leaves " and \' untouched', () => {
    assert.equal(escapeHtml(`"x" 'y'`), `"x" 'y'`);
  });

  test('escapeAttr escapes " and \' as well', () => {
    assert.equal(escapeAttr(`"x" 'y'`), '&quot;x&quot; &#39;y&#39;');
    assert.equal(escapeAttr('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  });

  test('replaces & first, so nothing is double-escaped', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    assert.equal(escapeAttr('&amp;'), '&amp;amp;');
  });

  test('passes Japanese text through unchanged', () => {
    assert.equal(escapeHtml('画面_表示されること'), '画面_表示されること');
  });
});

describe('validateReportName', () => {
  test('accepts valid names', () => {
    assert.doesNotThrow(() => validateReportName('image-report.html'));
    assert.doesNotThrow(() => validateReportName('レポート_01.html'));
  });

  test('rejects names containing : or /', () => {
    assert.throws(() => validateReportName('a:b.html'), /:/);
    assert.throws(() => validateReportName('dir/a.html'), /report-name/);
    assert.throws(() => validateReportName('dir\\a.html'), /report-name/);
  });

  test('rejects the other forbidden characters too', () => {
    for (const name of ['a"b', 'a<b', 'a>b', 'a|b', 'a*b', 'a?b', 'a\rb', 'a\nb']) {
      assert.throws(() => validateReportName(name), /not allowed in an artifact name/);
    }
  });

  test('rejects "." and ".." (join would resolve them to a directory)', () => {
    assert.throws(() => validateReportName('.'), /cannot be used as a file name/);
    assert.throws(() => validateReportName('..'), /cannot be used as a file name/);
  });

  test('rejects an empty name', () => {
    assert.throws(() => validateReportName(''), /report-name is empty/);
    assert.throws(() => validateReportName(undefined), /report-name is empty/);
  });
});

describe('imageSize', () => {
  test('reads PNG dimensions', () => {
    const file = writeTmp('size/a.png', pngBytes(300, 200));
    assert.deepEqual(imageSize(file), { width: 300, height: 200 });
  });

  test('reads JPEG dimensions (skipping the APP0 segment)', () => {
    const file = writeTmp('size/a.jpg', jpegBytes(640, 480));
    assert.deepEqual(imageSize(file), { width: 640, height: 480 });
  });

  test('does not misread 0xFF padding before SOF as a segment length', () => {
    const file = writeTmp('size/pad.jpg', jpegBytes(800, 600, { padBeforeSof: true }));
    assert.deepEqual(imageSize(file), { width: 800, height: 600 });
  });

  test('reads WebP (VP8 lossy) dimensions', () => {
    const f = writeTmp('vp8.webp', webpVp8(1600, 900));
    assert.deepEqual(imageSize(f), { width: 1600, height: 900 });
  });

  test('reads WebP (VP8L lossless) dimensions', () => {
    const f = writeTmp('vp8l.webp', webpVp8l(1600, 900));
    assert.deepEqual(imageSize(f), { width: 1600, height: 900 });
  });

  test('reads WebP (VP8X extended) dimensions', () => {
    const f = writeTmp('vp8x.webp', webpVp8x(1234, 567));
    assert.deepEqual(imageSize(f), { width: 1234, height: 567 });
  });
  test('returns null for unsupported formats', () => {
    const gif = writeTmp('size/a.gif', Buffer.from('GIF89a    ', 'binary'));
    assert.equal(imageSize(gif), null);
    const txt = writeTmp('size/a.txt', 'hello world, not an image at all');
    assert.equal(imageSize(txt), null);
  });

  test('returns null instead of throwing for a missing file', () => {
    assert.equal(imageSize(join(tmpRoot, 'size/does-not-exist.png')), null);
  });

  test('returns null instead of throwing when given a directory', () => {
    assert.equal(imageSize(join(tmpRoot, 'size')), null);
  });

  test('returns null for a file that is too short', () => {
    const file = writeTmp('size/short.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(imageSize(file), null);
  });
});

describe('walk', () => {
  let root;

  before(() => {
    root = join(tmpRoot, 'walk-root');
    writeTmp('walk-root/root.png', pngBytes(10, 10));
    writeTmp('walk-root/notes.txt', 'not an image');
    writeTmp('walk-root/.hidden.png', pngBytes(10, 10));
    writeTmp('walk-root/sub/a.JPG', jpegBytes(10, 10));
    writeTmp('walk-root/深い/階層/画面_表示されること.png', pngBytes(10, 10));
    writeTmp('walk-root/.hiddendir/x.png', pngBytes(10, 10));
    // A directory with no images (writeTmp cannot create it, since it has no files)
    mkdirSync(join(root, 'empty'), { recursive: true });
    // A symlink pointing at the parent: following it would loop forever
    symlinkSync(root, join(root, 'loop'), 'dir');
    symlinkSync(join(root, 'root.png'), join(root, 'link.png'), 'file');
  });

  test('recursively collects only files with a supported extension', () => {
    const rels = walk(root).map((f) => f.relPath).sort();
    assert.deepEqual(rels, ['root.png', 'sub/a.JPG', '深い/階層/画面_表示されること.png'].sort());
  });

  test('does not follow symlinks (neither directories nor files)', () => {
    const rels = walk(root).map((f) => f.relPath);
    assert.ok(!rels.some((r) => r.startsWith('loop/')), 'followed a directory symlink');
    assert.ok(!rels.includes('link.png'), 'collected a file symlink');
  });

  test('skips dot-prefixed files and directories', () => {
    const rels = walk(root).map((f) => f.relPath);
    assert.ok(!rels.includes('.hidden.png'));
    assert.ok(!rels.some((r) => r.startsWith('.hiddendir')));
  });

  test('relPath uses posix separators and absPath really points at the image', () => {
    const files = walk(root);
    assert.ok(files.length > 0);
    for (const f of files) {
      assert.ok(!f.relPath.includes('\\'), `relPath contains a backslash: ${f.relPath}`);
      assert.ok(!f.relPath.startsWith('/'), `relPath is absolute: ${f.relPath}`);
      assert.ok(f.absPath.endsWith(f.relPath.split('/').join(sep)), `absPath and relPath disagree: ${f.absPath}`);
      assert.deepEqual(imageSize(f.absPath), { width: 10, height: 10 });
    }
  });

  test('throws for a missing directory (handling absence is the caller\'s job)', () => {
    assert.throws(() => walk(join(tmpRoot, 'no-such-dir')), { code: 'ENOENT' });
  });

  test('returns an empty array for a directory with no images', () => {
    assert.deepEqual(walk(join(root, 'empty')), []);
  });
});

describe('groupIntoSections', () => {
  test('puts images at the root into the "." section, which comes first', () => {
    const sections = groupIntoSections([mk('sub/b.png'), mk('a.png')]);
    assert.equal(sections[0].dir, '.');
    assert.deepEqual(sections[0].files.map((f) => f.relPath), ['a.png']);
  });

  test('creates no section for a directory without images', () => {
    // walk returns nothing for an empty directory, so it never reaches the input
    const sections = groupIntoSections([mk('sub/a.png')]);
    assert.deepEqual(sections.map((s) => s.dir), ['sub']);
  });

  test('sorts the files within a section naturally (2 < 10)', () => {
    const sections = groupIntoSections([mk('s/10_x.png'), mk('s/2_x.png'), mk('s/1_x.png')]);
    assert.deepEqual(sections[0].files.map((f) => f.relPath), ['s/1_x.png', 's/2_x.png', 's/10_x.png']);
  });

  test('sorts the sections themselves naturally', () => {
    const sections = groupIntoSections([mk('s10/a.png'), mk('s2/a.png'), mk('s1/a.png')]);
    assert.deepEqual(sections.map((s) => s.dir), ['s1', 's2', 's10']);
  });

  test('uses the full nested directory path as the section name', () => {
    const sections = groupIntoSections([mk('深い/階層/日本語/a.png')]);
    assert.deepEqual(sections.map((s) => s.dir), ['深い/階層/日本語']);
  });

  test('returns an empty array for empty input', () => {
    assert.deepEqual(groupIntoSections([]), []);
  });
});

describe('buildHtml', () => {
  const readFile = () => Buffer.from([0x01, 0x02, 0x03]);

  const render = (options) => [...buildHtml({ readFile, ...options })].join('');

  const sampleSections = groupIntoSections([
    mk('a.png'),
    mk('sub/001_visit_foo.png'),
    mk('sub/icon.svg'),
    mk('深い/階層/画面_表示されること.jpg'),
  ]);

  test('emits a complete document starting with <!DOCTYPE html> and ending with </html>', () => {
    const html = render({ title: 'レポート', sections: sampleSections });
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'does not start with a DOCTYPE');
    assert.ok(html.trimEnd().endsWith('</html>'));
  });

  test('embeds one data URI per image, with the MIME type matching each extension', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.equal(html.match(/data:[^;]+;base64,/g).length, 4);
    assert.ok(html.includes('data:image/png;base64,AQID'));
    assert.ok(html.includes('data:image/svg+xml;base64,'));
    assert.ok(html.includes('data:image/jpeg;base64,'));
  });

  test('emits as many TOC anchors as there are sections', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.equal(html.match(/href="#sec-/g).length, sampleSections.length);
    assert.equal(html.match(/id="sec-/g).length, sampleSections.length);
  });

  test('labels the root section heading as (root)', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.ok(html.includes('(root)'));
  });

  test('inlines the CSS and JS (self-contained single file)', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('<script>'));
    assert.ok(!/<link\s/.test(html), 'references an external stylesheet');
    assert.ok(!/<script[^>]+src=/.test(html), 'references an external script');
  });

  test('marks images for lazy loading and async decoding', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.ok(html.includes('loading="lazy"'));
    assert.ok(html.includes('decoding="async"'));
  });

  test('includes the lightbox <dialog> but no arrow-key navigation', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.ok(html.includes('<dialog id="lightbox"'));
    assert.ok(html.includes('showModal()'));
    assert.ok(html.includes('closedby="any"'));
    assert.ok(!html.includes('ArrowRight'), 'prev/next navigation is out of scope for v1');
    assert.ok(!html.includes('<details'), 'collapsible sections are out of scope for v1');
    assert.ok(!html.includes('prefers-color-scheme'), 'dark mode is out of scope for v1');
  });

  test('normalizes captions while always keeping the original relative path', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.ok(html.includes('>visit foo<'), 'normalized caption is missing');
    assert.ok(html.includes('sub/001_visit_foo.png'), 'original relative path is missing');
    assert.ok(html.includes('title="sub/001_visit_foo.png"'), 'title attribute lacks the relative path');
  });

  test('passes captions through untouched with normalizeCaptions:false', () => {
    const html = render({ title: 't', sections: sampleSections, normalizeCaptions: false });
    assert.ok(html.includes('>001_visit_foo<'));
    assert.ok(!html.includes('>visit foo<'));
  });

  test('escapes markup characters in the title and in relative paths', () => {
    const sections = groupIntoSections([mk(`dir/<img>&"q".png`)]);
    const html = render({ title: '<b>t</b> & "x"', sections });
    assert.ok(!html.includes('<b>t</b>'), 'title is emitted raw');
    assert.ok(html.includes('&lt;b&gt;t&lt;/b&gt; &amp; "x"'));
    assert.ok(!html.includes('<img>&"q"'), 'relative path is emitted raw');
    assert.ok(html.includes('&lt;img&gt;&amp;&quot;q&quot;'), 'attribute value is not escaped');
  });

  test('renders Japanese paths as-is', () => {
    const html = render({ title: 't', sections: sampleSections });
    assert.ok(html.includes('深い/階層/画面_表示されること.jpg'));
    assert.ok(html.includes('>画面 表示されること<'));
  });

  test('still produces valid output when there are no sections', () => {
    const html = render({ title: 't', sections: [] });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('No images found.'));
    assert.equal(html.match(/href="#sec-/g), null);
  });

  test('yields multiple chunks rather than one big string (it is a generator)', () => {
    const chunks = [...buildHtml({ title: 't', sections: sampleSections, readFile })];
    assert.ok(chunks.length > sampleSections.length, 'output is not split into chunks');
    assert.ok(chunks.every((c) => typeof c === 'string'));
  });

  test('calls readFile exactly once per image, with an absolute path', () => {
    const calls = [];
    const spy = (p) => {
      calls.push(p);
      return Buffer.from([0]);
    };
    [...buildHtml({ title: 't', sections: sampleSections, readFile: spy })];
    assert.equal(calls.length, 4);
    assert.deepEqual(new Set(calls).size, 4);
    assert.ok(calls.every((p) => p.startsWith('/abs/')));
  });
});

describe('integration: walk -> groupIntoSections -> buildHtml', () => {
  test('builds a report from a real file tree', () => {
    const root = join(tmpRoot, 'integration');
    writeTmp('integration/001_root_level.png', pngBytes(600, 400));
    writeTmp('integration/landscape/10_wide.png', pngBytes(900, 300));
    writeTmp('integration/landscape/2_wide.png', pngBytes(900, 300));

    const sections = groupIntoSections(walk(root));
    assert.deepEqual(sections.map((s) => s.dir), ['.', 'landscape']);
    assert.deepEqual(
      sections[1].files.map((f) => f.relPath),
      ['landscape/2_wide.png', 'landscape/10_wide.png'],
    );

    const html = [...buildHtml({ title: 'integration', sections })].join('');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.equal(html.match(/data:image\/png;base64,/g).length, 3);
    assert.equal(html.match(/href="#sec-/g).length, 2);
  });
});
