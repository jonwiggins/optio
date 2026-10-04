import { ButtonLink } from "@/components/ui/button";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <div className="text-6xl font-bold text-text-muted/20">404</div>
        <h2 className="text-lg font-bold">Page not found</h2>
        <p className="text-sm text-text-muted">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
        <ButtonLink href="/">
          <Home />
          Back to Overview
        </ButtonLink>
      </div>
    </div>
  );
}
