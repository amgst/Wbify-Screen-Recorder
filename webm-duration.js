// MediaRecorder writes WebM files without a Duration in the Info header, so
// players show an unknown length and can't seek until the file has been played
// through. fixWebmDuration() inserts the missing Duration element.
//
// Only the first 64 KB is read; the rest of the file is reattached as a Blob
// slice, so multi-hundred-MB recordings are never loaded into memory.

const WEBM_ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549A966,
  CLUSTER: 0x1F43B675,
  DURATION: 0x4489,
  TIMECODE_SCALE: 0x2AD7B1,
  VOID: 0xEC
};

// EBML element IDs keep their length-marker bits and are 1-4 bytes long.
function webmReadId(view, pos) {
  if (pos >= view.byteLength) return null;
  const first = view.getUint8(pos);
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || pos + len > view.byteLength) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + view.getUint8(pos + i);
  return { value, len };
}

// Sizes are 1-8 bytes with the marker bit stripped. All value bits set means
// "unknown size" (used by live-written Segments and Clusters), returned as null.
function webmReadSize(view, pos) {
  if (pos >= view.byteLength) return null;
  const first = view.getUint8(pos);
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > view.byteLength) return null;
  let value = first & (0xFF >> len);
  let allOnes = value === (0xFF >> len);
  for (let i = 1; i < len; i++) {
    const b = view.getUint8(pos + i);
    if (b !== 0xFF) allOnes = false;
    value = value * 256 + b;
  }
  return { value: allOnes ? null : value, len };
}

// Encodes `value` as an EBML size occupying exactly `len` bytes, or null if it
// doesn't fit (the all-ones pattern is reserved for "unknown").
function webmEncodeSize(value, len) {
  if (value > Math.pow(2, 7 * len) - 2) return null;
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

async function fixWebmDuration(blob, durationMs) {
  if (!(durationMs > 0) || !blob || blob.size < 32) return blob;

  try {
    const head = await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer();
    const view = new DataView(head);

    // Top level: skip the EBML header to find the Segment
    let pos = 0;
    let segment = null;
    while (pos < view.byteLength) {
      const id = webmReadId(view, pos);
      const size = id && webmReadSize(view, pos + id.len);
      if (!id || !size) return blob;
      const dataStart = pos + id.len + size.len;
      if (id.value === WEBM_ID.SEGMENT) {
        segment = { sizePos: pos + id.len, sizeLen: size.len, size: size.value, dataStart };
        break;
      }
      if (size.value === null) return blob;
      pos = dataStart + size.value;
    }
    if (!segment) return blob;

    // Inside the Segment: find Info (it comes before the first Cluster)
    let info = null;
    pos = segment.dataStart;
    while (pos < view.byteLength) {
      const id = webmReadId(view, pos);
      const size = id && webmReadSize(view, pos + id.len);
      if (!id || !size || id.value === WEBM_ID.CLUSTER || size.value === null) break;
      const dataStart = pos + id.len + size.len;
      const dataEnd = dataStart + size.value;
      if (id.value === WEBM_ID.INFO) {
        info = { sizePos: pos + id.len, sizeLen: size.len, dataStart, dataEnd };
        break;
      }
      pos = dataEnd;
    }
    if (!info || info.dataEnd > view.byteLength) return blob;

    // Inside Info: bail out if a Duration already exists, and read the timecode scale
    let timecodeScale = 1000000; // nanoseconds per tick (WebM default)
    pos = info.dataStart;
    while (pos < info.dataEnd) {
      const id = webmReadId(view, pos);
      const size = id && webmReadSize(view, pos + id.len);
      if (!id || !size || size.value === null) return blob;
      const dataStart = pos + id.len + size.len;
      if (id.value === WEBM_ID.DURATION) return blob;
      if (id.value === WEBM_ID.TIMECODE_SCALE) {
        let scale = 0;
        for (let i = 0; i < size.value; i++) scale = scale * 256 + view.getUint8(dataStart + i);
        if (scale > 0) timecodeScale = scale;
      }
      pos = dataStart + size.value;
    }

    // Duration element: ID 0x4489, 8-byte size, float64 in timecode ticks
    const duration = new Uint8Array(11);
    duration[0] = 0x44;
    duration[1] = 0x89;
    duration[2] = 0x88;
    new DataView(duration.buffer).setFloat64(3, (durationMs * 1e6) / timecodeScale);
    const added = duration.length;

    const newInfoSize = info.dataEnd - info.dataStart + added;
    const infoSizeBytes = webmEncodeSize(newInfoSize, info.sizeLen);
    if (!infoSizeBytes) return blob;

    // Preferred: if a Void (padding) element directly follows Info, shrink it by
    // the same amount so nothing after Info moves and any seek offsets stay valid.
    let voidEl = null;
    const vid = webmReadId(view, info.dataEnd);
    const vsize = vid && vid.value === WEBM_ID.VOID && webmReadSize(view, info.dataEnd + vid.len);
    if (vsize && vsize.value !== null) {
      const total = vid.len + vsize.len + vsize.value;
      const newPayload = total - added - vid.len - vsize.len;
      const sizeBytes = newPayload >= 0 ? webmEncodeSize(newPayload, vsize.len) : null;
      if (sizeBytes && info.dataEnd + total <= view.byteLength) {
        voidEl = { end: info.dataEnd + total, sizeBytes, idLen: vid.len, sizeLen: vsize.len, newPayload };
      }
    }

    const parts = [];
    if (voidEl) {
      const voidHeader = new Uint8Array(voidEl.idLen + voidEl.sizeLen);
      voidHeader[0] = WEBM_ID.VOID; // single-byte ID
      voidHeader.set(voidEl.sizeBytes, voidEl.idLen);
      parts.push(
        blob.slice(0, info.sizePos), infoSizeBytes,
        blob.slice(info.dataStart, info.dataEnd), duration,
        voidHeader, new Uint8Array(voidEl.newPayload), // Void payload contents are ignored
        blob.slice(voidEl.end)
      );
    } else {
      // Nothing to absorb the extra bytes, so the Segment (if its size is known) grows too
      let cursor = 0;
      if (segment.size !== null) {
        const segSizeBytes = webmEncodeSize(segment.size + added, segment.sizeLen);
        if (!segSizeBytes) return blob;
        parts.push(blob.slice(0, segment.sizePos), segSizeBytes);
        cursor = segment.sizePos + segment.sizeLen;
      }
      parts.push(
        blob.slice(cursor, info.sizePos), infoSizeBytes,
        blob.slice(info.dataStart, info.dataEnd), duration,
        blob.slice(info.dataEnd)
      );
    }

    return new Blob(parts, { type: blob.type });
  } catch (err) {
    console.warn('Could not patch WebM duration, using the original recording', err);
    return blob;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fixWebmDuration };
}
