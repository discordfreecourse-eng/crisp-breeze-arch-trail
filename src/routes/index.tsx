import { createFileRoute } from "@tanstack/react-router";
import { MigrationApp } from "@/components/migration/app";
import { getOverview } from "@/lib/fn/migration";

export const Route = createFileRoute("/")({
  loader: () => getOverview(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  return <MigrationApp initial={initial} />;
}
