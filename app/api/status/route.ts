import { connectionStatus, probeConnections } from "@/lib/configuration";
import { requestId, responseHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = requestId();
  const live = new URL(request.url).searchParams.get("probe") === "1";
  return Response.json({
    connections: connectionStatus(),
    checks: live ? await probeConnections() : null,
  }, { headers: responseHeaders(id) });
}
