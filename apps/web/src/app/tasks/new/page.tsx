import { redirect } from "next/navigation";

/** Creation is one form now: every kind of work is a session. */
export default function Page() {
  redirect("/sessions/new");
}
