// Chrome's MediaRecorder writes fragmented MP4 whose header (moov) claims a
// duration of 0, so many players (Windows Media Player, Explorer, editors) show
// 0:00 or can't seek. fixMp4Duration() writes the real length into the movie,
// track-header and media-header duration fields.
//
// Every patch overwrites existing bytes in place (same size), so nothing in the
// file moves and no offsets need updating. Only the first 256 KB is read; the
// rest of the recording is reattached as Blob slices, never loaded into memory.

// Child boxes of [start, end): { type, start, dataStart, end }
function mp4Boxes(view, start, end) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = Number(view.getBigUint64(pos + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerLen) break;
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7)
    );
    boxes.push({ type, start: pos, dataStart: pos + headerLen, end: pos + size });
    pos += size;
  }
  return boxes;
}

// Field offsets (from the start of the box payload) differ between box versions.
function mp4TimeFields(view, dataStart, kind) {
  const v1 = view.getUint8(dataStart) === 1;
  if (kind === 'header') {
    // mvhd / mdhd: creation, modification, timescale, duration
    return v1
      ? { timescaleAt: dataStart + 20, durationAt: dataStart + 24, wide: true }
      : { timescaleAt: dataStart + 12, durationAt: dataStart + 16, wide: false };
  }
  // tkhd: creation, modification, track id, reserved, duration (movie timescale)
  return v1
    ? { durationAt: dataStart + 28, wide: true }
    : { durationAt: dataStart + 20, wide: false };
}

function mp4ReadDuration(view, fields) {
  return fields.wide
    ? Number(view.getBigUint64(fields.durationAt))
    : view.getUint32(fields.durationAt);
}

function mp4EncodeDuration(value, wide) {
  const bytes = new Uint8Array(wide ? 8 : 4);
  const dv = new DataView(bytes.buffer);
  if (wide) dv.setBigUint64(0, BigInt(value));
  else dv.setUint32(0, Math.min(value, 0xFFFFFFFF));
  return bytes;
}

async function fixMp4Duration(blob, durationMs) {
  if (!(durationMs > 0) || !blob || blob.size < 64) return blob;

  try {
    const head = await blob.slice(0, Math.min(blob.size, 262144)).arrayBuffer();
    const view = new DataView(head);

    const moov = mp4Boxes(view, 0, view.byteLength).find(b => b.type === 'moov');
    if (!moov || moov.end > view.byteLength) return blob;
    const moovKids = mp4Boxes(view, moov.dataStart, moov.end);

    const mvhd = moovKids.find(b => b.type === 'mvhd');
    if (!mvhd) return blob;
    const mvFields = mp4TimeFields(view, mvhd.dataStart, 'header');
    if (mp4ReadDuration(view, mvFields) > 0) return blob; // already has a duration

    const movieTimescale = view.getUint32(mvFields.timescaleAt);
    if (!movieTimescale) return blob;
    const patches = []; // { at, bytes }
    patches.push({ at: mvFields.durationAt, bytes: mp4EncodeDuration(Math.round(durationMs * movieTimescale / 1000), mvFields.wide) });

    for (const trak of moovKids.filter(b => b.type === 'trak')) {
      const trakKids = mp4Boxes(view, trak.dataStart, trak.end);

      const tkhd = trakKids.find(b => b.type === 'tkhd');
      if (tkhd) {
        const f = mp4TimeFields(view, tkhd.dataStart, 'track');
        patches.push({ at: f.durationAt, bytes: mp4EncodeDuration(Math.round(durationMs * movieTimescale / 1000), f.wide) });
      }

      const mdia = trakKids.find(b => b.type === 'mdia');
      const mdhd = mdia && mp4Boxes(view, mdia.dataStart, mdia.end).find(b => b.type === 'mdhd');
      if (mdhd) {
        const f = mp4TimeFields(view, mdhd.dataStart, 'header');
        const trackTimescale = view.getUint32(f.timescaleAt);
        if (trackTimescale) {
          patches.push({ at: f.durationAt, bytes: mp4EncodeDuration(Math.round(durationMs * trackTimescale / 1000), f.wide) });
        }
      }
    }

    patches.sort((a, b) => a.at - b.at);
    const parts = [];
    let cursor = 0;
    for (const patch of patches) {
      parts.push(blob.slice(cursor, patch.at), patch.bytes);
      cursor = patch.at + patch.bytes.length;
    }
    parts.push(blob.slice(cursor));
    return new Blob(parts, { type: blob.type });
  } catch (err) {
    console.warn('Could not patch MP4 duration, using the original recording', err);
    return blob;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fixMp4Duration };
}
