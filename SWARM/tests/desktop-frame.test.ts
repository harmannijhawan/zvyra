import { expect, it } from 'vitest';
import { encodeDesktopFrame } from '../electron/remote/frame';

it('encodes JPEG without corrupting the header or payload, with timestamp and length', () => {
  const image = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const packet = encodeDesktopFrame({ image, width: 1920, height: 1080, sequence: 42, timestamp: 1791130000000 });
  expect(packet.toString('ascii', 0, 4)).toBe('SWDF');
  expect(packet[4]).toBe(1);
  expect(packet[5]).toBe(1);
  expect(packet.readUInt16BE(6)).toBe(28);
  expect(packet.readUInt32BE(8)).toBe(42);
  expect(packet.readUInt16BE(12)).toBe(1920);
  expect(packet.readUInt16BE(14)).toBe(1080);
  expect(packet.readBigUInt64BE(16)).toBe(1791130000000n);
  expect(packet.readUInt32BE(24)).toBe(image.length);
  expect(packet.subarray(28)).toEqual(image);
});
