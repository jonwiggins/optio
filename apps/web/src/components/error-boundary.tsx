"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Label describing the section, shown in the fallback UI */
  label?: string;
  /** Additional CSS classes for the fallback container */
  className?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      JSON.stringify({
        type: "error_boundary",
        section: this.props.label ?? "unknown",
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className={"flex items-center justify-center p-6 " + (this.props.className ?? "h-full")}
        >
          <div className="text-center space-y-3 max-w-sm">
            <AlertCircle className="w-8 h-8 text-error/60 mx-auto" />
            <div>
              <p className="text-sm font-medium text-text">
                {this.props.label
                  ? `${this.props.label} failed to load`
                  : "This section failed to load"}
              </p>
              <p className="text-xs text-text-muted mt-1">
                An unexpected error occurred. Try again or reload the page.
              </p>
            </div>
            {process.env.NODE_ENV === "development" && this.state.error && (
              <pre className="text-[11px] text-error/70 bg-error/5 border border-error/20 rounded-md p-2 text-left overflow-auto max-h-32 whitespace-pre-wrap break-all">
                {this.state.error.message}
                {this.state.error.stack && `\n\n${this.state.error.stack}`}
              </pre>
            )}
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
