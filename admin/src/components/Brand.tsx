export function Brand({ big = false, env }: { big?: boolean; env?: string }) {
  return (
    <span className={`brand ${big ? "big" : ""}`}>
      {/* the Spatial Video Studio app icon (owner 2026-11-04), as a CSS
          background so customer-text checks for <img> stay meaningful */}
      <span className="brand-icon" aria-hidden="true" />
      Spatial Video Studio
      <span className="adm">admin{env && env !== "prod" ? ` · ${env}` : ""}</span>
    </span>
  );
}
