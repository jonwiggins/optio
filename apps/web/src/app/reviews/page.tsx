import { redirect } from "next/navigation";

export default function ReviewsPage() {
  redirect("/tasks?tab=prs");
}
