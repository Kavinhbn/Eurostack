import type { ConnectionDetail, ConnectionReport } from "./contracts.ts";

export function connectionStatus() {
  return {
    sanity: Boolean(process.env.SANITY_CONTEXT_MCP_URL && process.env.SANITY_ORGANIZATION_TOKEN),
    model: Boolean(process.env.MODEL_BASE_URL && process.env.MODEL_NAME),
    // Never allow an implicit cloud destination for a self-hosted installation.
    langfuse: Boolean(process.env.LANGFUSE_BASE_URL && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
  };
}

function configuredDetail(configured: boolean, label: string): ConnectionDetail {
  return configured
    ? { configured: true, state: "configured", detail: label + " is configured; run a live check to verify it." }
    : { configured: false, state: "not_configured", detail: label + " is not configured." };
}

async function probe(url: string, init: RequestInit, successDetail: string, timeoutMs = 4000): Promise<ConnectionDetail> {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual", cache: "no-store" });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) return { configured: true, state: "unreachable", latencyMs, detail: "The service responded with HTTP " + response.status + "." };
    await response.body?.cancel().catch(() => {});
    return { configured: true, state: "ready", latencyMs, detail: successDetail };
  } catch (error) {
    const code = error && typeof error === "object" && "cause" in error
      ? (error.cause as { code?: unknown } | undefined)?.code
      : undefined;
    const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "the configured service") : "";
    const reason = error instanceof DOMException && error.name === "TimeoutError"
      ? "The service did not answer before the health-check timeout."
      : "The service connection failed" + (typeof code === "string" ? " (" + code + ")" : "") + (message ? ": " + message : ".");
    return { configured: true, state: "unreachable", latencyMs: Math.round(performance.now() - started), detail: reason };
  }
}

export async function probeConnections(): Promise<ConnectionReport> {
  const status = connectionStatus();
  const sanityEndpoint = process.env.SANITY_CONTEXT_MCP_URL?.replace(/\/$/, "");
  const modelBase = process.env.MODEL_BASE_URL?.replace(/\/$/, "");
  const langfuseBase = process.env.LANGFUSE_BASE_URL?.replace(/\/$/, "");

  const sanity = status.sanity && sanityEndpoint
    ? probe(sanityEndpoint + "/initial-context", { headers: { Authorization: "Bearer " + process.env.SANITY_ORGANIZATION_TOKEN! } }, "Sanity Context accepted the organization token and returned its Knowledge Base outline.", 6000)
    : Promise.resolve(configuredDetail(false, "Sanity Context"));
  const model = status.model && modelBase
    ? probe(modelBase + "/models", { headers: process.env.MODEL_API_KEY ? { Authorization: "Bearer " + process.env.MODEL_API_KEY } : {} }, "The model endpoint is reachable.", 4000)
    : Promise.resolve(configuredDetail(false, "Answer model"));
  const langfuse = status.langfuse && langfuseBase
    ? probe(langfuseBase + "/api/public/ready", {}, "The self-hosted Langfuse instance reports ready.", 4000)
    : Promise.resolve(configuredDetail(false, "Self-hosted Langfuse"));

  const [sanityResult, modelResult, langfuseResult] = await Promise.all([sanity, model, langfuse]);
  return { sanity: sanityResult, model: modelResult, langfuse: langfuseResult, checkedAt: new Date().toISOString() };
}
