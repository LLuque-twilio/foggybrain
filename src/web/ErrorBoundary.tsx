import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('FoggyBrain UI render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <span className="eyebrow">FOGGYBRAIN</span>
        <h1>Something went wrong while drawing this view.</h1>
        <p>Your task data is still stored by the local server. Reload the app to try again.</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          Reload app
        </button>
        <details>
          <summary>Technical details</summary>
          <code>{this.state.error.message}</code>
        </details>
      </main>
    );
  }
}
