"use client";

import { useEffect } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page error:", error);
  }, [error]);

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4 max-w-md">
        <AlertCircle className="w-12 h-12 text-error mx-auto" />
        <h2 className="text-lg font-bold">Something went wrong</h2>
        <p className="text-sm text-text-muted">{error.message}</p>
        <Button onClick={reset} className="flex mx-auto">
          <RotateCcw />
          Try again
        </Button>
      </div>
    </div>
  );
}
