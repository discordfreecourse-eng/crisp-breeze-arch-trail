import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { handleOAuthCallback } = await import("@/lib/google/oauth.server");
        const target = await handleOAuthCallback(request);
        return new Response(null, {
          status: 302,
          headers: { location: target },
        });
      },
    },
  },
});
