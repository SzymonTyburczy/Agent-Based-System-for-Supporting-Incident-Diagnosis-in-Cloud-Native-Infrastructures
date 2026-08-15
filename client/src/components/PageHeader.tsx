import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Above the title — badges, ids. */
  eyebrow?: ReactNode;
  /** Under the description — service, timestamp. */
  meta?: ReactNode;
}

export function PageHeader({ title, description, actions, eyebrow, meta }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      {/* flex-1 + a basis floor: the title column fills the row and, once it
          would be squeezed below ~18rem, the actions wrap onto their own line
          instead of shredding the heading into one word per line. min-w-0
          keeps a long unbroken title from overflowing. */}
      <div className="min-w-0 flex-1 basis-72">
        {eyebrow && <div className="mb-2 flex flex-wrap items-center gap-2">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">{description}</p>
        )}
        {meta && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
