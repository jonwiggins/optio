"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function RedirectPage({ to }: { to: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return (
    <p className="text-text-muted">
      Redirecting to{" "}
      <Link href={to} className="text-primary-light hover:underline">
        {to}
      </Link>
      …
    </p>
  );
}
