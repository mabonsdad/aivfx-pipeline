type CharacterAnimatePlaceholderTabProps = {
  title: string;
  body: string;
};

export default function CharacterAnimatePlaceholderTab({ title, body }: CharacterAnimatePlaceholderTabProps) {
  return (
    <div className="rounded-xl border border-dashed border-ink/15 bg-bg p-4">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink/65">{body}</p>
    </div>
  );
}
