import type { DesktopFrame } from './desktop';

// SWDF v1, big endian: magic(4), version(1), codec JPEG(1), header length(2),
// sequence(4), width(2), height(2), timestamp milliseconds(8), payload length(4).
export const FRAME_HEADER_SIZE = 28;
export function encodeDesktopFrame(frame: DesktopFrame): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.write('SWDF', 0, 'ascii');
  header[4] = 1;
  header[5] = 1;
  header.writeUInt16BE(FRAME_HEADER_SIZE, 6);
  header.writeUInt32BE(frame.sequence >>> 0, 8);
  header.writeUInt16BE(frame.width, 12);
  header.writeUInt16BE(frame.height, 14);
  header.writeBigUInt64BE(BigInt(frame.timestamp), 16);
  header.writeUInt32BE(frame.image.length, 24);
  return Buffer.concat([header, frame.image]);
}
