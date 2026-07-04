/**
 * Shared presentation for the static legal pages (/privacy, /terms):
 * one column, quiet typography in the studio vocabulary. Server-safe —
 * no client state anywhere in the legal pages.
 */

export function LegalShell({
  title,
  effective,
  children,
}: {
  title: string;
  effective: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-sm text-fg-muted">
        Effective {effective} · Stereo3D Studio, a Spatial AI Labs Ltd
        product
      </p>
      <div className="mt-10 space-y-10">{children}</div>
    </section>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-fg-muted [&_li]:mt-1.5 [&_strong]:font-medium [&_strong]:text-fg [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
