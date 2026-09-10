import { createFileRoute } from "@tanstack/react-router";

const MAX_BYTES = 25 * 1024 * 1024;

export const Route = createFileRoute("/api/jobs/pdf")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ error: "Choose a PDF file." }, { status: 400 });
        }
        const file = form.get("file");
        if (!(file instanceof File)) {
          return Response.json({ error: "Choose a PDF file." }, { status: 400 });
        }
        if (file.size > MAX_BYTES) {
          return Response.json({ error: "PDF is larger than 25 MB." }, { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { extractDriveLinksFromPdf } = await import("@/lib/pdf/extract.server");
        const { extractDriveLinksFromText } = await import("@/lib/google/links");
        const fromPdf = await extractDriveLinksFromPdf(bytes);
        const fromName = extractDriveLinksFromText(file.name);
        const merged = new Map(fromPdf.map((l) => [l.driveId, l]));
        for (const link of fromName) merged.set(link.driveId, link);
        const links = [...merged.values()];
        if (links.length === 0) {
          return Response.json(
            { error: "No Google Drive links found in that PDF." },
            { status: 422 },
          );
        }
        const { createJobFromLinks, assertNoActiveWork } = await import("@/lib/jobs/store.server");
        try {
          await assertNoActiveWork();
        } catch (err) {
          const message = err instanceof Error ? err.message : "Job is busy.";
          return Response.json({ error: message }, { status: 409 });
        }
        const job = await createJobFromLinks({
          filename: file.name || "upload.pdf",
          links,
        });
        return Response.json({ jobId: job.id, count: links.length });
      },
    },
  },
});
