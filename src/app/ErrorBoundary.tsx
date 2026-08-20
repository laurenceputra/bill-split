import React, { type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { hasError: boolean };

export class AppErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error('BillSplit failed to render', error, errorInfo);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <main className="app-error-boundary" role="alert"><div className="app-error-boundary__card"><p className="eyebrow">BillSplit</p><h1>Something went wrong</h1><p className="muted">The app could not finish loading. Your local data and pending expenses were not cleared.</p><button type="button" onClick={() => window.location.reload()}>Reload</button></div></main>;
  }
}
