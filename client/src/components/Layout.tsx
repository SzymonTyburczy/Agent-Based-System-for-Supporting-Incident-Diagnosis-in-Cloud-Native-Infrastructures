import { NavLink, Outlet } from "react-router-dom";
import { Activity, FileText, LayoutDashboard, Settings, ShieldAlert } from "lucide-react";
import { getGeminiApiKey } from "../lib/settings";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/documentation", label: "Documentation", icon: FileText },
  { to: "/issues", label: "Issues", icon: ShieldAlert },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const hasKey = Boolean(getGeminiApiKey());

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg)]">
      {/* Below md the sidebar collapses to an icon-only rail. */}
      <aside className="flex w-16 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:w-64">
        <div className="flex items-center gap-3 px-3.5 py-5 md:px-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)]">
            <Activity className="h-5 w-5 text-white" />
          </div>
          <div className="hidden leading-tight md:block">
            <div className="text-sm font-semibold text-white">IDAR</div>
            <div className="text-[11px] text-[var(--color-muted)]">
              Incident Diagnosis Assistant (RAG)
            </div>
          </div>
        </div>

        <nav className="mt-2 flex-1 space-y-1 px-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  "justify-center md:justify-start",
                  isActive
                    ? "bg-[var(--color-surface-2)] text-white"
                    : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]/60 hover:text-white",
                ].join(" ")
              }
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="hidden md:inline">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[var(--color-border)] p-3">
          <div
            title={hasKey ? "Gemini API: key configured" : "Gemini API: no key"}
            className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2.5 text-xs md:justify-start"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                hasKey ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]"
              }`}
            />
            <span className="hidden text-[var(--color-muted)] md:inline">
              Gemini API: {hasKey ? "key configured" : "no key"}
            </span>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-6xl flex-col px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
