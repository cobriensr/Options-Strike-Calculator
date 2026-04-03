import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import * as Sentry from '@sentry/react';

interface Props {
  children: ReactNode;
  /** When set, renders a compact inline fallback instead of a full-page error. */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
    Sentry.captureException(error, {
      extra: { componentStack: info.componentStack },
    });
  }

  render() {
    if (this.state.hasError) {
      // Section-level: compact inline fallback
      if (this.props.label) {
        return (
          <div
            className="bg-surface border-edge rounded-lg border p-4 text-center"
            role="alert"
          >
            <p className="text-secondary text-sm">
              {this.props.label} failed to render.
            </p>
            {this.state.error && (
              <pre className="text-danger mt-2 overflow-auto text-xs">
                {this.state.error.message}
              </pre>
            )}
          </div>
        );
      }

      // Top-level: full-page fallback
      return (
        <div className="mx-auto mt-20 max-w-lg p-8 text-center font-sans">
          <h1 className="mb-2 text-xl">Something went wrong</h1>
          <p className="text-secondary mb-5 text-sm">
            An unexpected error occurred. Try refreshing the page.
          </p>
          {this.state.error && (
            <pre className="text-danger bg-surface-alt mb-4 max-h-[120px] overflow-auto rounded-lg p-3 text-left text-xs">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => globalThis.location.reload()}
            className="bg-surface border-edge-strong cursor-pointer rounded-lg border-[1.5px] px-6 py-2.5 text-sm font-semibold"
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
