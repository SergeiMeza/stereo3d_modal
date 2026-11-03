export function Brand({ big = false, env }: { big?: boolean; env?: string }) {
  return (
    <span className={`brand ${big ? "big" : ""}`}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M16 3 28 10v12l-12 7-12-7V10z M16 3v26 M4 10l12 7 12-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      Stereo3D Studio
      <span className="adm">admin{env && env !== "prod" ? ` · ${env}` : ""}</span>
    </span>
  );
}
