import { CATALOG, CATALOG_VERSION, CASE } from "@/lib/catalog";
import { requestId, responseHeaders } from "@/lib/http";

export function GET(request: Request) {
  const id = requestId();
  const etag = 'W/"rackwise-catalog-' + CATALOG_VERSION + '"';
  const headers = responseHeaders(id, {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    ETag: etag,
  });
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return Response.json({ version: CATALOG_VERSION, case: CASE, modules: CATALOG }, { headers });
}
