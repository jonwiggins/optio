import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";

/** Keep background sync results current for as long as the section is open. */
export function useInstalledSkills() {
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const result = await api.listInstalledSkills();
      if (mounted.current && current === request.current) setSkills(result.skills);
    } catch {
      // Keep the last result on transient failures; the next poll retries.
    } finally {
      if (mounted.current && current === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      active = false;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  return { skills, setSkills, loading, refresh };
}
