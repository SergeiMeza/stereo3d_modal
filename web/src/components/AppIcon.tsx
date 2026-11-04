/**
 * The Spatial Video Studio app icon (the App Store app's "3D" icon, owner
 * 2026-11-04: the web app carries the app's name and icon). Decorative
 * beside the name; size it with className (e.g. size-6).
 */

import Image from "next/image";

export function AppIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/app-icon.png"
      alt=""
      aria-hidden
      width={64}
      height={64}
      className={`shrink-0 rounded-[22%] ${className ?? ""}`}
    />
  );
}
