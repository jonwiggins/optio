import { redirect } from "next/navigation";

/** The form moved from /sessions/new to /work/new (v0.6). */
export default function Page() {
  redirect("/work/new");
}
