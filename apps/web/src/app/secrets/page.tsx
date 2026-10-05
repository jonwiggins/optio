import { redirect } from "next/navigation";

/** Secrets live under Library → Connections now (the deployment's own are in Settings). */
export default function SecretsPage() {
  redirect("/connections?kind=secret");
}
