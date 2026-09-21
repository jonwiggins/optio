"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** Jobs are edited in the unified session form now. */
export default function EditWorkflowRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/work/${id}/edit`);
  }, [id, router]);
  return null;
}
