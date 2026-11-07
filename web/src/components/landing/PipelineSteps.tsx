"use client";

/**
 * "What happens to your video" — the three conversion passes, each
 * illustrated with a short looping clip made from licensed footage
 * (2026-11): a glowing line sweeps across the clip and shows how near or
 * far everything is; the scene seen from a swaying viewpoint, then its two
 * eye views; the result on a floating window, a headset and XR glasses.
 * Copy rules from web/docs/LANDING.md apply: say what it does, no internal
 * pipeline terms.
 *
 * Each clip has an MP4 (H.264, listed first) and a WebM (VP9) source and a poster
 * (LoopVideo: plays only while on screen, poster under reduced motion).
 */

import { LoopVideo } from "@/components/landing/LoopVideo";
import { useT } from "@/lib/i18n/I18nProvider";

export function PipelineSteps() {
  const t = useT();
  const steps = [
    {
      number: "01",
      tag: t("landing.pipeline.depthTag"),
      title: t("landing.pipeline.depthTitle"),
      detail: t("landing.pipeline.depthDetail"),
      clip: "/landing/steps/depth",
      label: t("landing.pipeline.depthLabel"),
    },
    {
      number: "02",
      tag: t("landing.pipeline.stereoTag"),
      title: t("landing.pipeline.stereoTitle"),
      detail: t("landing.pipeline.stereoDetail"),
      clip: "/landing/steps/stereo",
      label: t("landing.pipeline.stereoLabel"),
    },
    {
      number: "03",
      tag: t("landing.pipeline.deliveryTag"),
      title: t("landing.pipeline.deliveryTitle"),
      detail: t("landing.pipeline.deliveryDetail"),
      clip: "/landing/steps/delivery",
      label: t("landing.pipeline.deliveryLabel"),
    },
  ];
  return (
    <div className="space-y-12">
      {steps.map((step, index) => (
        <div
          key={step.number}
          className="grid items-center gap-6 lg:grid-cols-2 lg:gap-12"
        >
          <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
            <p className="font-mono text-[11px] tracking-wide text-primary uppercase">
              {step.number} · {step.tag}
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-fg">
              {step.title}
            </h3>
            <p className="mt-2 max-w-xl leading-relaxed text-fg-muted">
              {step.detail}
            </p>
          </div>
          <div className={index % 2 === 1 ? "lg:order-1" : undefined}>
            <LoopVideo
              base={step.clip}
              label={step.label}
              className="aspect-video w-full rounded-lg border border-edge bg-card object-cover"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
