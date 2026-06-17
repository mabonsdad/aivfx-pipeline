type ProjectBadgeProps = {
  name: string;
  className?: string;
};

export default function ProjectBadge({ name, className = "" }: ProjectBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-800 ${className}`.trim()}
    >
      {name}
    </span>
  );
}
