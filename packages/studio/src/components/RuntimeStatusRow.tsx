import React from "react";

export function RuntimeStatusRow({ icon, title, tone, message, details }: {
  icon: React.ReactNode;
  title: string;
  tone: "ok" | "warn" | "wait";
  message?: string;
  details?: ReadonlyArray<{ label: string; value: string }>;
}) {
  const prioritizeDetails = title === "Headroom MCP" && Boolean(details?.length);
  const toneClass =
    tone === "ok"
      ? "bg-emerald-500/12 text-emerald-500"
      : tone === "warn"
        ? "bg-amber-500/12 text-amber-500"
        : "bg-secondary text-muted-foreground";
  return (
    <section className="rounded-2xl border border-border/55 bg-background/45 p-4">
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${toneClass}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {message && !prioritizeDetails ? <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{message}</p> : null}
          {details && details.length > 0 ? (
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              {details.map((detail) => (
                <div key={`${title}-${detail.label}`} className="rounded-xl border border-border/45 bg-card/55 px-3 py-2">
                  <dt className="text-[11px] font-medium text-muted-foreground/80">{detail.label}</dt>
                  <dd className="mt-1 break-words text-xs leading-5 text-foreground">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </section>
  );
}
