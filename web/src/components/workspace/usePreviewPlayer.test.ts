/**
 * usePreviewPlayer unit tests — the workspace's ONLY frame↔time mapping,
 * exercised against a fake PreviewVideoLike element (jsdom never plays
 * media; the hook is written against the minimal element surface exactly
 * so these tests can drive it directly).
 *
 * Frame doctrine checks:
 * - seeks land MID-frame (frameToSeconds(f) + half a frame), never on a
 *   boundary time that is ambiguous between two frames;
 * - mediaTime → frame mapping floors through secondsToFrame, exact for
 *   NTSC rationals (24000/1001) across long ranges;
 * - pausing snaps both the readout and the video to the exact frame under
 *   the paused time.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { frameToSeconds, parseRational } from "@/lib/frames";

import {
  currentTimeToFrame,
  mediaTimeToFrame,
  seekTimeForFrame,
  usePreviewPlayer,
  type PreviewFrameMetadata,
  type PreviewVideoLike,
} from "./usePreviewPlayer";

const FPS24 = parseRational("24/1");
const NTSC = parseRational("24000/1001");

type FrameCallback = (now: number, metadata: PreviewFrameMetadata) => void;

class FakeVideo implements PreviewVideoLike {
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  playCalls = 0;
  pauseCalls = 0;
  requestVideoFrameCallback?: (callback: FrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  cancelledHandles: number[] = [];

  private listeners = new Map<string, Set<() => void>>();
  private frameCallbacks: FrameCallback[] = [];
  private nextHandle = 1;

  constructor(options: { rvfc?: boolean } = {}) {
    if (options.rvfc) {
      this.requestVideoFrameCallback = (callback) => {
        this.frameCallbacks.push(callback);
        return this.nextHandle++;
      };
      this.cancelVideoFrameCallback = (handle) => {
        this.cancelledHandles.push(handle);
        this.frameCallbacks = [];
      };
    }
  }

  play(): unknown {
    this.playCalls++;
    this.paused = false;
    this.emit("play");
    return undefined;
  }

  pause(): void {
    this.pauseCalls++;
    this.paused = true;
    this.emit("pause");
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** Present one video frame at `mediaTime` (drains the pending rVFC
   * callbacks; the hook re-registers from inside its callback). */
  presentFrame(mediaTime: number): void {
    const callbacks = this.frameCallbacks;
    this.frameCallbacks = [];
    for (const callback of callbacks) callback(0, { mediaTime });
  }
}

function renderPlayer(video: FakeVideo | null, fps = FPS24) {
  const onFrame = vi.fn<(frame: number) => void>();
  const videoRef = { current: video as PreviewVideoLike | null };
  const hook = renderHook(() => usePreviewPlayer(videoRef, fps, onFrame));
  return { ...hook, onFrame };
}

describe("seekTimeForFrame / mediaTimeToFrame", () => {
  it("seeks to the frame's MID-point, never a boundary time", () => {
    // 24/1: frame f starts at f/24; seek lands at f/24 + 1/48
    expect(seekTimeForFrame(0, FPS24)).toBe(1 / 48);
    expect(seekTimeForFrame(100, FPS24)).toBe(100 / 24 + 1 / 48);
    // strictly inside the frame's interval [f/24, (f+1)/24)
    expect(seekTimeForFrame(100, FPS24)).toBeGreaterThan(frameToSeconds(100, FPS24));
    expect(seekTimeForFrame(100, FPS24)).toBeLessThan(frameToSeconds(101, FPS24));
  });

  it("round-trips seek time → frame exactly via currentTimeToFrame (floor)", () => {
    for (const fps of [FPS24, NTSC, parseRational("30000/1001"), parseRational("60/1")]) {
      for (let f = 0; f <= 100_000; f += 997) {
        expect(currentTimeToFrame(seekTimeForFrame(f, fps), fps)).toBe(f);
      }
    }
  });

  it("currentTimeToFrame floors arbitrary times (mid-playback semantics)", () => {
    expect(currentTimeToFrame(frameToSeconds(100, NTSC), NTSC)).toBe(100);
    // just before the boundary → still inside the previous frame
    expect(currentTimeToFrame(frameToSeconds(100, NTSC) - 1e-6, NTSC)).toBe(99);
  });

  it("mediaTimeToFrame survives Chromium's MICROSECOND-quantized rVFC timestamps", () => {
    // Chromium reports mediaTime as integer microseconds. Frames whose PTS
    // is not a whole µs come back up to 0.5µs off — floor mapped them to
    // the PREVIOUS frame and left the frame stepper stuck (observed live:
    // frame 245 @24fps reported as 10.208333). Round-to-nearest is the
    // correct inverse for a frame-START timestamp.
    const quantizeUs = (s: number) => Math.round(s * 1e6) / 1e6;
    // the exact frames from the live reproduction
    expect(mediaTimeToFrame(10.208333, FPS24)).toBe(245); // truncated low
    expect(mediaTimeToFrame(10.291667, FPS24)).toBe(247); // rounded high
    expect(mediaTimeToFrame(10.333333, FPS24)).toBe(248); // truncated low
    // exhaustive sweep: every frame in a minute, all common rates
    for (const fps of [FPS24, NTSC, parseRational("30000/1001"), parseRational("60/1")]) {
      const frames = Math.ceil((60 * fps.num) / fps.den);
      for (let f = 0; f <= frames; f++) {
        expect(mediaTimeToFrame(quantizeUs(frameToSeconds(f, fps)), fps)).toBe(f);
      }
    }
  });

  it("mediaTimeToFrame maps exact presentation timestamps too", () => {
    expect(mediaTimeToFrame(frameToSeconds(100, NTSC), NTSC)).toBe(100);
    expect(mediaTimeToFrame(0, FPS24)).toBe(0);
  });
});

describe("usePreviewPlayer — frame readout", () => {
  // Real browsers report mediaTime as the presented frame's START (PTS),
  // never the requested currentTime — and Chromium quantizes it to integer
  // microseconds (observed live; see mediaTimeToFrame tests above).
  const quantizeUs = (s: number) => Math.round(s * 1e6) / 1e6;

  it("reports frames from rVFC mediaTime (frame-start presentation times)", () => {
    const video = new FakeVideo({ rvfc: true });
    const { onFrame } = renderPlayer(video);

    act(() => video.presentFrame(frameToSeconds(42, FPS24)));
    expect(onFrame).toHaveBeenLastCalledWith(42);

    // the hook re-registers after every presented frame; Chromium's
    // µs-truncated PTS for frame 245 (the live sticky-step bug) maps right
    act(() => video.presentFrame(quantizeUs(frameToSeconds(245, FPS24))));
    expect(onFrame).toHaveBeenLastCalledWith(245);
  });

  it("maps NTSC mediaTime to the exact source frame", () => {
    const video = new FakeVideo({ rvfc: true });
    const { onFrame } = renderPlayer(video, NTSC);

    act(() => video.presentFrame(quantizeUs(frameToSeconds(1234, NTSC))));
    expect(onFrame).toHaveBeenLastCalledWith(1234);
    act(() => video.presentFrame(frameToSeconds(1235, NTSC)));
    expect(onFrame).toHaveBeenLastCalledWith(1235);
  });

  it("falls back to timeupdate + currentTime without rVFC", () => {
    const video = new FakeVideo();
    const { onFrame } = renderPlayer(video);

    video.currentTime = seekTimeForFrame(7, FPS24);
    act(() => video.emit("timeupdate"));
    expect(onFrame).toHaveBeenLastCalledWith(7);
  });

  it("cancels the rVFC loop on unmount", () => {
    const video = new FakeVideo({ rvfc: true });
    const { unmount, onFrame } = renderPlayer(video);

    unmount();
    expect(video.cancelledHandles.length).toBeGreaterThan(0);
    video.presentFrame(seekTimeForFrame(9, FPS24));
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe("usePreviewPlayer — transport", () => {
  it("seekToFrame sets the mid-frame time and reports the frame immediately", () => {
    const video = new FakeVideo({ rvfc: true });
    const { result, onFrame } = renderPlayer(video);

    act(() => result.current.seekToFrame(99));
    expect(video.currentTime).toBe(seekTimeForFrame(99, FPS24));
    expect(onFrame).toHaveBeenLastCalledWith(99);
    expect(result.current.playing).toBe(false);
  });

  it("play() starts playback; pause() snaps video + readout to the exact frame", () => {
    const video = new FakeVideo();
    const { result, onFrame } = renderPlayer(video);

    act(() => result.current.play());
    expect(result.current.playing).toBe(true);
    expect(video.playCalls).toBe(1);

    // playback advanced somewhere inside frame 50's interval
    video.currentTime = frameToSeconds(50, FPS24) + 0.001;
    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    expect(video.pauseCalls).toBe(1);
    expect(onFrame).toHaveBeenLastCalledWith(50);
    // …and the pixels are re-seeked to match the readout
    expect(video.currentTime).toBe(seekTimeForFrame(50, FPS24));
  });

  it("toggle() alternates play/pause", () => {
    const video = new FakeVideo();
    const { result } = renderPlayer(video);

    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(false);
    expect(video.playCalls).toBe(1);
    expect(video.pauseCalls).toBe(1);
  });

  it("stays honest against native events (pause/ended from the browser)", () => {
    const video = new FakeVideo();
    const { result } = renderPlayer(video);

    act(() => video.emit("play")); // e.g. native controls
    expect(result.current.playing).toBe(true);

    act(() => video.emit("ended"));
    expect(result.current.playing).toBe(false);

    act(() => video.emit("play"));
    act(() => video.emit("pause"));
    expect(result.current.playing).toBe(false);
  });

  it("reverts to paused when the play() promise rejects (autoplay policy)", async () => {
    const video = new FakeVideo();
    video.play = () => {
      video.playCalls++;
      return Promise.reject(new Error("NotAllowedError"));
    };
    const { result } = renderPlayer(video);

    await act(async () => {
      result.current.play();
    });
    expect(result.current.playing).toBe(false);
  });

  it("setSpeed drives video.playbackRate and the reported speed", () => {
    const video = new FakeVideo();
    const { result } = renderPlayer(video);

    expect(result.current.speed).toBe(1);
    act(() => result.current.setSpeed(0.5));
    expect(result.current.speed).toBe(0.5);
    expect(video.playbackRate).toBe(0.5);
    // playback transport doesn't reset the rate
    act(() => {
      result.current.play();
      result.current.pause();
      result.current.seekToFrame(10);
    });
    expect(video.playbackRate).toBe(0.5);
  });

  it("re-applies the speed when the element resets to 1× (remount)", () => {
    const video = new FakeVideo();
    const { result, rerender } = renderPlayer(video);

    act(() => result.current.setSpeed(2));
    video.playbackRate = 1; // a fresh <video> always starts at 1×
    rerender();
    expect(video.playbackRate).toBe(2);
  });

  it("is a no-op without a mounted video element", () => {
    const { result, onFrame } = renderPlayer(null);

    act(() => {
      result.current.play();
      result.current.pause();
      result.current.seekToFrame(5);
      result.current.toggle();
    });
    expect(result.current.playing).toBe(false);
    expect(onFrame).not.toHaveBeenCalled();
  });
});
