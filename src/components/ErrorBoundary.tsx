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
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
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
        <div
          style={{
            maxWidth: 520,
            margin: '80px auto',
            padding: 32,
            fontFamily: 'system-ui, sans-serif',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ color: '#666', fontSize: 14, marginBottom: 20 }}>
            An unexpected error occurred. Try refreshing the page.
          </p>
          {this.state.error && (
            <pre
              style={{
                background: '#f5f5f5',
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                textAlign: 'left',
                overflow: 'auto',
                maxHeight: 120,
                color: '#c00',
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => globalThis.location.reload()}
            style={{
              marginTop: 16,
              padding: '10px 24px',
              borderRadius: 8,
              border: '1.5px solid #ccc',
              background: '#fff',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
