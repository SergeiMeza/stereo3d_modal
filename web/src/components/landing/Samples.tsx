"use client";

/**
 * "Watch the 3D result in your headset" (2026-11): one tile per sample
 * clip with its downloads — Vision Pro spatial video, side by side for the
 * other headsets and XR glasses, and the 2D original to compare. A tile
 * shows its poster until asked to play, then a short muted loop from the
 * CDN, as the original or in red-cyan; nothing loads before that, and
 * nothing ever plays with sound. Copy rules from web/docs/LANDING.md apply.
 */

import { Download, Play } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { track } from "@/lib/analytics";
import { formatBytes } from "@/lib/format";
import { SAMPLES, type Sample } from "@/lib/samples";

type Look = "2d" | "redcyan";

function SampleTile({ sample }: { sample: Sample }) {
  const [playing, setPlaying] = useState(false);
  const [look, setLook] = useState<Look>("2d");
  const loop = look === "2d" ? sample.loop : sample.redCyanLoop;

  function play(next: Look) {
    setLook(next);
    if (!playing) track("lp_sample_play", { clip: sample.slug, look: next });
    setPlaying(true);
  }

  return (
    <article
      data-testid={`sample-${sample.slug}`}
      className="flex flex-col overflow-hidden rounded-xl border border-edge bg-card"
    >
      <div className="relative aspect-video bg-black">
        {playing ? (
          <video
            key={look}
            // muted autoplay can still be refused (data saver, background
            // tab): ask once
            ref={(v) => {
              if (v) void Promise.resolve(v.play()).catch(() => undefined);
            }}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            poster={sample.poster}
            aria-label={`${sample.title}, ${look === "2d" ? "the 2D video" : "in red-cyan 3D"}`}
            className="absolute inset-0 h-full w-full object-cover"
          >
            {/* H.264 first: iPhone Safari paints the VP9 WebM black */}
            <source src={loop.mp4} type="video/mp4" />
            <source src={loop.webm} type="video/webm" />
          </video>
        ) : (
          <>
            <Image
              src={sample.poster}
              alt={sample.title}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 380px"
              className="object-cover"
            />
            <button
              type="button"
              onClick={() => play("2d")}
              aria-label={`Play a short muted preview of ${sample.title}`}
              className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors hover:bg-black/25"
            >
              <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-black shadow">
                <Play aria-hidden className="size-5 translate-x-px" />
              </span>
            </button>
          </>
        )}
        <div className="absolute right-2 bottom-2 flex rounded-md bg-black/60 p-0.5 text-[11px] text-white">
          {(["2d", "redcyan"] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={playing && look === l}
              onClick={() => play(l)}
              className={`rounded px-2 py-0.5 transition-colors ${
                playing && look === l ? "bg-white/25" : "hover:bg-white/15"
              }`}
            >
              {l === "2d" ? "2D" : "Red-cyan"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-medium text-fg">{sample.title}</h3>
        <p className="mt-1 text-sm text-fg-muted">{sample.detail}</p>
        <p className="mt-1 text-xs text-fg-muted">
          {sample.seconds} s · {sample.size}
        </p>
        <ul className="mt-3 space-y-1.5">
          {sample.downloads.map((d) => (
            <li key={d.kind}>
              <a
                href={d.href}
                download
                onClick={() =>
                  track("lp_sample_download", { clip: sample.slug, format: d.kind })
                }
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                  d.kind === "2d"
                    ? "border-transparent text-fg-muted hover:text-fg"
                    : "border-edge text-fg hover:border-primary/40"
                }`}
              >
                <Download aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                <span className="flex-1">{d.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-fg-muted">
                  {d.ext} · {formatBytes(d.bytes)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function Samples() {
  return (
    <section
      id="samples"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16"
    >
      <p className="text-xs font-medium tracking-widest text-primary uppercase">
        Samples
      </p>
      <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
        Watch the 3D result in your headset
      </h2>
      <p className="mt-3 max-w-2xl text-fg-muted">
        Made with Lifelike 3D in Spatial Video Studio on the web. Download one
        to your headset, or the 2D original to compare.
      </p>
      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {SAMPLES.map((s) => (
          <SampleTile key={s.slug} sample={s} />
        ))}
      </div>
    </section>
  );
}
