import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  FileText,
  LayoutDashboard,
  Radio,
  Settings,
  ShieldAlert,
  WifiOff,
} from "lucide-react";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { ReportsStream } from "./ReportsStream";
import { useStreamStatus } from "../hooks/streamContext";
import { getGeminiApiKey } from "../lib/settings";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/documentation", label: "Documentation", icon: FileText },
  { to: "/issues", label: "Issues", icon: ShieldAlert },
  { to: "/settings", label: "Settings", icon: Settings },
];

const streamStates = {
  live: {
    Icon: Radio,
    label: "Live updates",
    title: "Live updates: connected",
    color: "text-[var(--color-success)]",
  },
  connecting: {
    Icon: Radio,
    label: "Reconnecting…",
    title: "Live updates: reconnecting",
    color: "text-[var(--color-warning)]",
  },
  offline: {
    Icon: WifiOff,
    label: "Offline",
    title: "Live updates: offline — the issues list may be stale",
    color: "text-[var(--color-danger)]",
  },
};

/**
 * Connection health belongs in the sidebar next to the Gemini indicator, not
 * as a banner on top of an incident report. Without it, a dead stream (agent
 * stopped, wrong token) leaves a healthy-looking list that has quietly
 * stopped updating.
 */
function StreamStatusPill() {
  const { Icon, label, title, color } = streamStates[useStreamStatus()];

  return (
    <div
      title={title}
      className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-surface-2)] px-3 py-2.5 text-xs md:justify-start"
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />
      <span className="hidden text-[var(--color-muted)] md:inline">{label}</span>
    </div>
  );
}

export function Layout() {
  const hasKey = Boolean(getGeminiApiKey());
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // <main> is the scroller, not window, and nothing reset it — invisible only
  // while the detail page was pinned to one viewport.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <ReportsStream>
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

          <div className="space-y-2 border-t border-[var(--color-border)] p-3">
            <StreamStatusPill />
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

        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex h-full max-w-6xl flex-col px-4 py-6 md:px-8 md:py-8">
            {/* Keyed by pathname so navigating away clears a caught error. */}
            <AppErrorBoundary key={pathname}>
              <Outlet />
            </AppErrorBoundary>
          </div>
        </main>
      </div>
    </ReportsStream>
  );
}
