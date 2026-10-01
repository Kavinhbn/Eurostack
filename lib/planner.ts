import { z } from "zod";
import { CATALOG, CATALOG_VERSION, CASE, calculatePlan } from "./catalog.ts";
import { connectionStatus } from "./configuration.ts";
import type { PlanInput, PlanResult, TraceStep } from "./contracts.ts";
import { checkRateLimit, requestId, responseHeaders } from "./http.ts";
import { observed, traced } from "./langfuse.ts";
import { combineEvidenceClaims, createEvidenceAssessment, extractStructuredClaims, type CatalogFact, type CoverageTarget } from "./evidence.ts";
import { synthesizeAssessment } from "./model.ts";
import { retrieveRackEvidence } from "./sanity-context.ts";

export const planSchema = z.object({
  question: z.string().trim().min(1, "Enter a question.").max(2000, "Keep your question under 2,000 characters.").default("Check this row's width, depth and power reserve."),
  moduleIds: z.array(z.string().refine((id) => CATALOG.some((item) => item.id === id), "Choose modules from the catalog.")).min(1, "Add at least one module.").max(32, "A plan can contain at most 32 modules."),
  headroom: z.number().finite().min(0).max(0.5).default(0.2),
}).strict();

export function createCoverageAwareExplanation(
  calculation: ReturnType<typeof calculatePlan>,
  headroom: number,
  assessment: PlanResult["assessment"],
) {
  const labels: Record<string, string> = { width: "row width", depth: "depth clearance", plus12: "+12V budget", minus12: "−12V budget", plus5: "+5V budget" };
  const failed = Object.entries(calculation.checks).filter(([, pass]) => !pass).map(([key]) => labels[key]);
  const numerical = failed.length
    ? "This rack needs a change before installation. Review the " + failed.join(", ") + "."
    : "Yes. This row fits within the current planning limits with a " + Math.round(headroom * 100) + "% power reserve. It uses " + calculation.totals.hp + " of " + CASE.hp + " HP, and the deepest module is " + calculation.totals.depthMm + " mm against the " + CASE.maxDepthMm + " mm planning clearance.";
  const modules = assessment.coverage.targets.filter((target) => target.kind === "module");
  const missing = modules.filter((target) => target.status === "missing" || target.status === "unverified").map((target) => target.subject);
  const variantMismatch = modules.find((target) => target.status === "variant_mismatch");
  const conflicts = assessment.claims.filter((claim) => claim.status === "conflicts");
  if (conflicts.length) return numerical + " Retrieved evidence contains " + conflicts.length + " conflicting " + (conflicts.length === 1 ? "claim" : "claims") + ", so review the Evidence view before relying on this plan.";
  if (!assessment.claims.length) return numerical + " No validated source-backed comparison was available for this run, so the result is catalog-only.";
  const caseSentence = assessment.coverage.caseVerified
    ? "The case profile is supported by Sanity evidence."
    : "The case profile has not been fully validated by the retrieved evidence.";
  if (variantMismatch) {
    const verified = assessment.coverage.verifiedModules;
    return numerical + " " + caseSentence + " I matched source-backed specifications for " + verified + " of " + modules.length + " selected modules. One item still needs the correct source: this rack contains Disting EX, while the retrieved entry is for Disting NT. I kept those models separate and did not use the NT measurements to verify the EX. Confirm the Disting EX specifications before installation.";
  }
  if (!missing.length) return numerical + " " + caseSentence + " All " + modules.length + " selected module " + (modules.length === 1 ? "type has" : "types have") + " at least one aligned source-backed comparison.";
  return numerical + " " + caseSentence + " I could not match a validated source claim for " + missing.join(", ") + ". Those modules remain part of the catalog calculation, but they are not presented as independently verified.";
}

export async function runPlan(input: PlanInput): Promise<PlanResult> {
  const started = performance.now();
  const connections = connectionStatus();
  const trace: TraceStep[] = [];
  const calculation = calculatePlan(input.moduleIds, input.headroom);
  trace.push({ name: "Constraint check", status: "success", durationMs: Math.round(performance.now() - started), detail: "Width, depth and all three power rails calculated from catalog " + CATALOG_VERSION + "." });
  const sources = [
    { title: "Intellijel TPS80W supply", url: CASE.sourceUrl, note: CASE.note },
    ...[...new Set(input.moduleIds)].map((id) => {
      const rackModule = CATALOG.find((item) => item.id === id)!;
      return { title: rackModule.maker + " · " + rackModule.name, url: rackModule.sourceUrl, note: rackModule.note || "Manufacturer specification snapshot." };
    }),
  ];
  const catalogFacts: CatalogFact[] = [
    { key: "case.width", subject: CASE.name, property: "width", value: CASE.hp, unit: "HP", displayValue: CASE.hp + " HP" },
    { key: "case.depth", subject: CASE.name, property: "depth", value: CASE.maxDepthMm, unit: "mm", displayValue: CASE.maxDepthMm + " mm planning clearance" },
    { key: "case.plus12", subject: CASE.name, property: "plus12", value: CASE.plus12Ma, unit: "mA", displayValue: CASE.plus12Ma + " mA" },
    { key: "case.minus12", subject: CASE.name, property: "minus12", value: CASE.minus12Ma, unit: "mA", displayValue: CASE.minus12Ma + " mA" },
    { key: "case.plus5", subject: CASE.name, property: "plus5", value: CASE.plus5Ma, unit: "mA", displayValue: CASE.plus5Ma + " mA" },
    ...[...new Set(input.moduleIds)].flatMap((id) => {
      const rackModule = CATALOG.find((item) => item.id === id)!;
      return [
        { key: id + ".width", subject: rackModule.name, property: "width" as const, value: rackModule.hp, unit: "HP", displayValue: rackModule.hp + " HP" },
        { key: id + ".depth", subject: rackModule.name, property: "depth" as const, value: rackModule.depthMm, unit: "mm", displayValue: rackModule.depthMm + " mm" },
        { key: id + ".plus12", subject: rackModule.name, property: "plus12" as const, value: rackModule.plus12Ma, unit: "mA", displayValue: rackModule.plus12Ma + " mA" },
        { key: id + ".minus12", subject: rackModule.name, property: "minus12" as const, value: rackModule.minus12Ma, unit: "mA", displayValue: rackModule.minus12Ma + " mA" },
        { key: id + ".plus5", subject: rackModule.name, property: "plus5" as const, value: rackModule.plus5Ma, unit: "mA", displayValue: rackModule.plus5Ma + " mA" },
      ].filter((fact) => !(["plus12", "minus12", "plus5"].includes(fact.property) && fact.value === 0));
    }),
  ];
  const coverageTargets: CoverageTarget[] = [
    { key: "case", subject: CASE.name, kind: "case" },
    ...[...new Set(input.moduleIds)].map((id) => ({ key: id, subject: CATALOG.find((item) => item.id === id)!.name, kind: "module" as const })),
  ];
  const warnings = [CASE.note, "Startup peaks, connector capacity and unlisted accessories are not calculated. Check the manufacturer instructions before powering hardware."];
  if (input.moduleIds.includes("plaits")) warnings.push(CATALOG.find((item) => item.id === "plaits")!.note!);
  const { output, queued } = await traced("rackwise-plan", input, async () => {
    let evidence: string | null = null;
    let paths: string[] = [];
    let explanation: string | null = null;
    let assessmentModel: Awaited<ReturnType<typeof synthesizeAssessment>> = null;
    let structuredClaims: ReturnType<typeof extractStructuredClaims> = [];
    let analysisFailed = false;
    let stepStart = performance.now();
    if (connections.sanity) {
      try {
        const retrieval = await observed("sanity-retrieval", { moduleCount: calculation.modules.length }, () => retrieveRackEvidence(calculation.modules.map((item) => item.name), input.question));
        evidence = retrieval.evidence; paths = retrieval.paths;
        trace.push({ name: "Sanity Context", status: "success", durationMs: Math.round(performance.now() - stepStart), detail: paths.length + " Knowledge Base paths read through MCP." });
        warnings.push("Retrieved knowledge informs the explanation, but does not automatically overwrite catalog numbers. Review any disagreement before relying on this plan.");
      } catch {
        analysisFailed = true;
        warnings.push("Sanity Context could not be read. This result uses the local catalog only; check the endpoint, token and Knowledge Base paths.");
        trace.push({ name: "Sanity Context", status: "error", durationMs: Math.round(performance.now() - stepStart), detail: "Retrieval failed or timed out. Catalog calculations are still available." });
      }
    } else {
      trace.push({ name: "Sanity Context", status: "skipped", durationMs: 0, detail: "Endpoint and organization token are not configured. No live knowledge was retrieved." });
    }
    if (evidence) {
      structuredClaims = extractStructuredClaims({ evidence, paths, catalogFacts });
      trace.push({ name: "Structured claims", status: "success", durationMs: 0, detail: structuredClaims.length + " cited specification claims extracted directly from Knowledge Base entries." });
    } else {
      trace.push({ name: "Structured claims", status: "skipped", durationMs: 0, detail: "No Knowledge Base entries were available for deterministic extraction." });
    }
    stepStart = performance.now();
    if (connections.model) {
      try {
        assessmentModel = await observed("model-explanation", { hasKnowledgeBaseEvidence: Boolean(evidence) }, () => synthesizeAssessment({ question: input.question, calculation, catalogFacts, catalogSources: sources, evidence, paths }));
        trace.push({ name: "Evidence analysis", status: "success", durationMs: Math.round(performance.now() - stepStart), detail: (assessmentModel?.claims.length || 0) + " source-backed claims returned under the structured evidence contract." });
      } catch {
        analysisFailed = true;
        warnings.push("The optional AI synthesis did not complete. Rackwise still answered from deterministic rack checks and any structured, source-backed Knowledge Base claims shown in Evidence.");
        trace.push({ name: "Evidence analysis", status: "error", durationMs: Math.round(performance.now() - stepStart), detail: "AI synthesis failed, timed out, or did not satisfy the evidence contract. The answer falls back to deterministic checks and structured Knowledge Base claims." });
      }
    } else trace.push({ name: "Evidence analysis", status: "skipped", durationMs: 0, detail: "No model configured. This run checks numbers only, not the free-text question." });
    const names: Record<string, string> = { width: "row width", depth: "depth clearance", plus12: "+12V budget", minus12: "−12V budget", plus5: "+5V budget" };
    const failed = Object.entries(calculation.checks).filter(([, pass]) => !pass).map(([key]) => names[key]);
    const answer = failed.length
      ? "This row exceeds the configured " + failed.join(", ") + ". Remove or replace modules, or review the planning profile before proceeding."
      : "This row passes the five numerical checks with a " + Math.round(input.headroom * 100) + "% power reserve. It uses " + calculation.totals.hp + " of " + CASE.hp + " HP; the deepest module is " + calculation.totals.depthMm + " mm against the assumed " + CASE.maxDepthMm + " mm clearance. Verify the physical setup before installation.";
    const combinedModel = combineEvidenceClaims(assessmentModel, structuredClaims);
    const assessedTargets = coverageTargets.map((target) => target.key === "disting-ex" && evidence && /\bdisting\s+nt\b/i.test(evidence) && !/\bdisting\s+ex\b/i.test(evidence)
      ? { ...target, mismatch: "The Knowledge Base covers Disting NT. This rack uses Disting EX, so the NT measurements were not used." }
      : target);
    const assessment = createEvidenceAssessment({ model: combinedModel, analysisFailed, evidence, paths, catalogFacts, coverageTargets: assessedTargets });
    if (combinedModel) explanation = createCoverageAwareExplanation(calculation, input.headroom, assessment);
    if (assessment.decision.status === "conflict") warnings.push("Source-backed claims conflict with the current catalog or with each other. Review the Evidence view before relying on this plan.");
    return { answer, explanation, evidence, paths, assessment };
  });
  trace.push({ name: "Local Langfuse", status: queued ? "success" : connections.langfuse ? "error" : "skipped", durationMs: 0, detail: queued ? "Trace queued to your configured self-hosted endpoint. Delivery has not been confirmed." : connections.langfuse ? "Tracing could not initialize. The plan was still checked." : "Self-hosted URL and project keys are not configured. Timings above are measured by Rackwise." });
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), input, calculation, ...output, sources, trace, durationMs: Math.round(performance.now() - started), warnings, mode: output.evidence ? "sanity" : "catalog", catalogVersion: CATALOG_VERSION };
}

export async function handlePlanRequest(request: Request) {
  const id = requestId();
  const started = performance.now();
  const rate = checkRateLimit(request);
  const rateHeaders = {
    "RateLimit-Limit": String(rate.limit),
    "RateLimit-Remaining": String(rate.remaining),
    ...(rate.allowed ? {} : { "Retry-After": String(rate.retryAfter) }),
  };
  const headers = responseHeaders(id, rateHeaders);
  if (!rate.allowed) return Response.json({ error: "Too many checks. Try again shortly.", code: "RATE_LIMITED", requestId: id }, { status: 429, headers });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Cross-origin requests are not allowed.", code: "ORIGIN_REJECTED", requestId: id }, { status: 403, headers });
  if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "Send a JSON request.", code: "UNSUPPORTED_MEDIA_TYPE", requestId: id }, { status: 415, headers });
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body");
    let raw = "", size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) return Response.json({ error: "Request is too large.", code: "REQUEST_TOO_LARGE", requestId: id }, { status: 413, headers });
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    body = JSON.parse(raw);
  } catch { return Response.json({ error: "The request must contain valid JSON.", code: "INVALID_JSON", requestId: id }, { status: 400, headers }); }
  const parsed = planSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0].message, code: "INVALID_PLAN", requestId: id }, { status: 400, headers });
  try {
    const result = await runPlan(parsed.data);
    return Response.json(result, { headers: responseHeaders(id, { ...rateHeaders, "Server-Timing": "total;dur=" + (performance.now() - started).toFixed(1) }) });
  } catch {
    return Response.json({ error: "The check could not be completed. Please try again.", code: "PLAN_FAILED", requestId: id }, { status: 500, headers });
  }
}
