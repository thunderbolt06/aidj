import { redirect } from "next/navigation";

// The compilation deck IS the home page now.
export default function CompilationPage() {
  redirect("/");
}
