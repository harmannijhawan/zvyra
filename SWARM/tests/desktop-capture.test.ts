import { afterEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => {
  const image: any = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }), toJPEG: () => Buffer.from('real-source-jpeg') };
  image.resize = () => image;
  return { image, getSources: vi.fn(async () => [{ id: 'screen:1', display_id: '1', thumbnail: image }]) };
});
vi.mock('electron', () => ({ desktopCapturer: { getSources: source.getSources }, screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 100, y: 50, width: 1920, height: 1080 } }), dipToScreenPoint: (p: unknown) => p } }));
import { DesktopCapture } from '../electron/remote/desktop';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('desktop capture lifecycle and real image coordinates', () => {
  it('shares startup between concurrent reconnects and keeps a static desktop alive', async () => {
    vi.useFakeTimers();
    const capture = new DesktopCapture();
    const frames: any[] = [];
    await Promise.all([capture.start({ maxFps: 20 }), capture.start({ maxFps: 20 })]);
    expect(source.getSources).toHaveBeenCalledTimes(1);
    capture.subscribe(frame => frames.push(frame));
    await vi.advanceTimersByTimeAsync(1100);
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ width: 1280, height: 720, sequence: 1 });
    expect(frames[0].image).toEqual(Buffer.from('real-source-jpeg'));
    capture.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.length).toBe(2);
  });

  it('does not restart a stream that was stopped while the OS source was loading', async () => {
    vi.useFakeTimers();
    let finish!: (sources: any[]) => void;
    source.getSources.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const capture = new DesktopCapture();
    const start = capture.start();
    capture.stop();
    finish([{ id: 'screen:1', display_id: '1', thumbnail: source.image }]);
    await expect(start).rejects.toThrow('stopped during capture startup');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps against the touched frame after a quality change rather than a newer frame', async () => {
    vi.useFakeTimers();
    const capture = new DesktopCapture();
    await capture.start();
    capture.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    expect(capture.mapInput({ type: 'click', x: 320, y: 180, frameWidth: 640, frameHeight: 360 })).toMatchObject({ x: 1060, y: 590 });
    expect(capture.mapInput({ type: 'move', x: 12, y: -3, relative: true })).toMatchObject({ x: 12, y: -3 });
    capture.stop();
  });
});
