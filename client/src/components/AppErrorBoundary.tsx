import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Without this, any render throw unmounts the entire React 19 root — a blank
 * white page whose only recovery is a manual reload. `main.tsx` mounts
 * `<StrictMode><BrowserRouter><App/>` with nothing in between to catch one.
 *
 * A class component because that is still the only way to declare an error
 * boundary; it uses no TypeScript parameter properties, so it stays legal
 * under `erasableSyntaxOnly`.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[idar] render error", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card flex flex-col items-center gap-2 border-[var(--color-danger)]/40 py-16 text-center">
        <AlertTriangle className="h-5 w-5 text-[var(--color-danger)]" />
        <p className="text-sm text-[var(--color-danger)]">
          Something went wrong rendering this page.
        </p>
        <p className="text-xs text-[var(--color-muted)]">{error.message}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-surface-2)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Reload
        </button>
      </div>
    );
  }
}
