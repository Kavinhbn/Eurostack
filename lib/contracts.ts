import type { Calculation } from "./catalog.ts";

export type PlanInput = { question: string; moduleIds: string[]; headroom: number };
export type StepState = "success" | "skipped" | "error";
export type TraceStep = { name: string; status: StepState; durationMs: number; detail: string };
export type Connections = { sanity: boolean; model: boolean; langfuse: boolean };
export type ConnectionState = "ready" | "configured" | "not_configured" | "unreachable";
export type ConnectionDetail = {
  configured: boolean;
  state: ConnectionState;
  detail: string;
  latencyMs?: number;
};
export type ConnectionReport = {
  sanity: ConnectionDetail;
  model: ConnectionDetail;
  langfuse: ConnectionDetail;
  checkedAt: string;
};
export type EvidenceProperty = "width" | "depth" | "plus12" | "minus12" | "plus5" | "compatibility" | "other";
export type EvidenceClaimStatus = "agrees" | "conflicts" | "unverified";
export type EvidenceClaim = {
  id: string;
  subject: string;
  property: EvidenceProperty;
  displayValue: string;
  normalizedValue: number | null;
  unit: string | null;
  catalogKey: string | null;
  catalogValue: string | null;
  sourceTitle: string;
  sourceUrl: string | null;
  knowledgePath: string | null;
  statement: string;
  status: EvidenceClaimStatus;
};
export type EvidenceDecision = {
  status: "supported" | "partial" | "conflict" | "insufficient" | "catalog_only";
  confidence: "high" | "medium" | "low";
  blocking: boolean;
  summary: string;
  basis: string;
};
export type EvidenceAssessment = {
  decision: EvidenceDecision;
  claims: EvidenceClaim[];
  gaps: string[];
  coverage: {
    caseVerified: boolean;
    verifiedModules: number;
    totalModules: number;
    targets: Array<{
      key: string;
      subject: string;
      kind: "case" | "module";
      status: "aligned" | "conflict" | "unverified" | "variant_mismatch" | "missing";
      claimCount: number;
      note: string | null;
    }>;
  };
};
export type PlanResult = {
  id: string; createdAt: string; input: PlanInput; calculation: Calculation;
  answer: string; explanation: string | null; evidence: string | null; paths: string[];
  sources: Array<{ title: string; url: string; note: string }>;
  trace: TraceStep[]; durationMs: number; warnings: string[];
  mode: "catalog" | "sanity"; catalogVersion: string;
  assessment: EvidenceAssessment;
};
