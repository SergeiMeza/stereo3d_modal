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
      "A video-native model assigns every pixel a distance, consistent from frame to frame — the foundation the 3D is built on.",
    src: "/landing/steps/depth.mp4",
    label: "Source footage side by side with its animated depth map",
  },
  {
    number: "02",
    tag: "Stereo",
    title: "Two eyes from one camera",
    detail:
      "Left and right views are synthesized around the source footage, and the pixels a new viewpoint reveals are filled in with motion-aware inpainting. Shown here as a red-cyan anaglyph you can check on any screen.",
    src: "/landing/steps/stereo.mp4",
    label: "The same footage as a red-cyan anaglyph 3D preview",
  },
  {
    number: "03",
    tag: "Deliver",
    title: "Plays like it was shot in 3D",
    detail:
      "The stereo pair is encoded to spatial video, side-by-side and more — ready for Apple Vision Pro, Samsung Galaxy XR, Meta Quest and 3D displays.",
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
