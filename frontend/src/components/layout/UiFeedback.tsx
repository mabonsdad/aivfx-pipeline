import { useState, type ReactNode } from "react";

type StatusVariant = "info" | "loading" | "warning" | "error" | "success";

const statusClasses: Record<StatusVariant, string> = {
  info: "border-ink/15 bg-bg/70 text-ink/75",
  loading: "border-accent/20 bg-accent/5 text-ink/80",
  warning: "border-amber-300 bg-amber-50 text-amber-950",
  error: "border-red-200 bg-red-50 text-red-700",
  success: "border-teal-500 bg-teal-50 text-ink/80",
};

export function Spinner(props: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current/25 border-t-current ${props.className ?? ""}`} />;
}

export function PendingButtonLabel(props: { isPending: boolean; idle: string; pending: string }) {
  if (!props.isPending) return <>{props.idle}</>;
  return (
    <span className="inline-flex items-center gap-2">
      <Spinner className="h-3.5 w-3.5" />
      <span>{props.pending}</span>
    </span>
  );
}

export function StatusNotice(props: {
  variant: StatusVariant;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${statusClasses[props.variant]} ${props.className ?? ""}`}>
      <div className="flex items-start gap-2">
        {props.variant === "loading" ? <Spinner className="mt-0.5 h-4 w-4 shrink-0" /> : null}
        <div className="min-w-0">
          {props.title ? <p className="font-semibold">{props.title}</p> : null}
          <div>{props.children}</div>
        </div>
      </div>
    </div>
  );
}

export function HelpInfoButton(props: { title: string; lines: string[]; label?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={props.label ?? props.title}
        title={props.label ?? props.title}
        onClick={() => setIsOpen(true)}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ink/20 bg-white text-[10px] font-semibold text-ink/70"
      >
        i
      </button>
      {isOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-2xl border border-ink/10 bg-card p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold">{props.title}</h3>
              </div>
              <button type="button" className="rounded border border-ink/20 bg-white px-3 py-1.5 text-sm" onClick={() => setIsOpen(false)}>
                Close
              </button>
            </div>
            <div className="mt-4 space-y-3 text-sm leading-6 text-ink/80">
              {props.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
