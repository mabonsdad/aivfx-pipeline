import type { ReactNode } from "react";

export function PreviewIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function CompareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <path d="M12 6v12" />
      <path d="M12 9a3 3 0 1 1 0 6" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m6 6 1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="m16.5 3.5 4 4L8 20H4v-4L16.5 3.5Z" />
    </svg>
  );
}

type IconActionButtonProps = {
  title: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger" | "accent";
  children: ReactNode;
};

const toneClasses: Record<NonNullable<IconActionButtonProps["tone"]>, string> = {
  default: "border-ink/20 bg-white text-ink",
  danger: "border-red-200 bg-white text-red-700",
  accent: "border-accent/25 bg-white text-accent",
};

export function IconActionButton({ title, onClick, href, download, disabled, tone = "default", children }: IconActionButtonProps) {
  const className = `rounded border p-2 text-xs ${toneClasses[tone]} disabled:cursor-not-allowed disabled:opacity-50`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" download={download} title={title} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" title={title} className={className} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
