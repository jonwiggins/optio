"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { Zap, Loader2, KeyRound } from "lucide-react";

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  github: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  ),
  google: (
    <svg className="w-5 h-5" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  ),
  gitlab: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path
        d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"
        fill="#E24329"
      />
    </svg>
  ),
};

export default function LoginPage() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const [providers, setProviders] = useState<Array<{ name: string; displayName: string }>>([]);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getAuthProviders()
      .then((res) => {
        setProviders(res.providers);
        setAuthDisabled(res.authDisabled);
        if (res.authDisabled) {
          // Auth is disabled, redirect to home
          window.location.href = "/";
        }
      })
      .catch(() => {
        // If we can't reach the API, show a fallback
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-sm mx-auto p-8">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2.5 text-primary mb-2">
            <Zap className="w-7 h-7" />
            <span className="font-semibold text-2xl tracking-tight">Optio</span>
          </div>
          <p className="text-sm text-text-muted">Sign in to continue</p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
            {error === "invalid_state"
              ? "Login session expired. Please try again."
              : error === "missing_params"
                ? "Missing authorization parameters."
                : `Authentication error: ${error}`}
          </div>
        )}

        {providers.length === 0 && !authDisabled ? (
          <div className="text-center text-sm text-text-muted">
            <p>No authentication providers configured.</p>
            <p className="mt-2 text-xs">
              Set{" "}
              <code className="px-1 py-0.5 bg-bg-card rounded text-primary">
                OPTIO_AUTH_DISABLED=true
              </code>{" "}
              to bypass authentication, or configure OAuth provider credentials.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((provider) => (
              <a
                key={provider.name}
                href={`/api/auth/${provider.name}/login`}
                className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg border border-border bg-bg-card text-sm font-medium hover:bg-bg-hover transition-colors"
              >
                {PROVIDER_ICONS[provider.name] ?? <KeyRound className="w-5 h-5" />}
                Sign in with {provider.displayName}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
