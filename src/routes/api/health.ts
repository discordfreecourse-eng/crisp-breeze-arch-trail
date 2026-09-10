import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const { ensureWorkerStarted, tickWorker } = await import("@/lib/jobs/worker.server");
        const { isLongRunningProcess } = await import("@/lib/google/env.server");
        const { getSql } = await import("@/lib/db");
        try {
          const sql = await getSql();
          await sql`select 1 as ok`;
        } catch (err) {
          const message = err instanceof Error ? err.message : "db_unavailable";
          return Response.json(
            { ok: false, service: "raw-copy", error: message },
            { status: 503 },
          );
        }
        ensureWorkerStarted();
        if (!isLongRunningProcess()) {
          await tickWorker();
        }
        return Response.json({
          ok: true,
          service: "raw-copy",
          longRunning: isLongRunningProcess(),
        });
      },
    },
  },
});
