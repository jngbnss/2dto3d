import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken panel from taking the whole editor down — a CAD session can
 * represent a lot of unsaved work, and the autosaved document stays intact even
 * when a panel throws.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel panel--crash">
          <h3>{this.props.label} stopped working</h3>
          <pre>{this.state.error.message}</pre>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
