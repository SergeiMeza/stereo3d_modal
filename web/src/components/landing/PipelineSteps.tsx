/**
 * "What happens to your video" — the three conversion passes, each
 * illustrated with a short looping clip (the same footage moving through
 * depth → stereo → playback). Copy rules from web/docs/LANDING.md apply:
 * say what it does, no internal pipeline terms.
 */

const STEPS = [
  {
    number: "01",
    tag: "Depth",
    title: "Depth, measured for every frame",
    detail:
      "We work out how far away everything is in every frame, steady from frame to frame — the base the 3D is built on.",
    src: "/landing/steps/depth.mp4",
    label: "Source footage side by side with its depth, near bright and far dark",
  },
  {
    number: "02",
    tag: "3D",
    title: "Two eyes from one camera",
    detail:
      "A left and a right view are made for every frame, and the areas each eye newly sees are filled in naturally. Shown here in red-cyan, which you can check on any screen with paper glasses.",
    src: "/landing/steps/stereo.mp4",
    label: "The same footage as a red-cyan 3D preview",
  },
  {
    number: "03",
    tag: "Files",
    title: "Plays like it was shot in 3D",
    detail:
      "Your 3D video comes as Vision Pro spatial video and side by side — ready for Apple Vision Pro, Samsung Galaxy XR, Meta Quest, Pico and 3D displays.",
    src: "/landing/steps/delivery.mp4",
    label: "The converted video playing on a virtual home-theater screen",
  },
];

export function PipelineSteps() {
  return (
    <div className="space-y-12">
      {STEPS.map((step, index) => (
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
            <video
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              aria-label={step.label}
              className="w-full rounded-lg border border-edge bg-card"
            >
              <source src={step.src} type="video/mp4" />
            </video>
          </div>
        </div>
      ))}
    </div>
  );
}
