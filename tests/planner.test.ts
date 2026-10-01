import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlan, DEFAULT_MODULE_IDS } from "../lib/catalog.ts";
import { createCoverageAwareExplanation, handlePlanRequest, planSchema } from "../lib/planner.ts";
import { parseRpcResponse, selectKnowledgePaths } from "../lib/sanity-context.ts";
import { combineEvidenceClaims, createEvidenceAssessment, extractStructuredClaims, type CatalogFact } from "../lib/evidence.ts";
import { compactEvidenceForModel, parseModelAssessment } from "../lib/model.ts";

test("default row uses the corrected catalog and reserved power limits", () => {
  const plan = calculatePlan(DEFAULT_MODULE_IDS);
  assert.deepEqual(plan.totals, { hp: 56, depthMm: 50, plus12Ma: 514, minus12Ma: 130, plus5Ma: 0 });
  assert.equal(plan.limits.plus12Ma, 2400);
  assert.equal(plan.fits, true);
});

test("empty rows are not reported as passing", () => {
  assert.equal(calculatePlan([]).fits, false);
  assert.equal(planSchema.safeParse({ moduleIds: [] }).success, false);
});

test("repeated modules count as individual physical modules", () => {
  const plan = calculatePlan(Array(6).fill("maths"));
  assert.equal(plan.totals.hp, 120);
  assert.equal(plan.checks.width, false);
  assert.equal(plan.fits, false);
});

test("unknown modules and invalid reserves cannot silently pass", () => {
  assert.throws(() => calculatePlan(["unknown"]));
  for (const reserve of [-0.2, 0.8, NaN, Infinity]) assert.throws(() => calculatePlan(["maths"], reserve));
  assert.equal(planSchema.safeParse({ moduleIds: ["maths"], headroom: "0.2" }).success, false);
});

test("API rejects invalid input before calling any external services", async () => {
  for (const [body, expected] of [["{", 400], [JSON.stringify({ moduleIds: [] }), 400], [JSON.stringify({ moduleIds: ["unknown"] }), 400], [" ".repeat(17000), 413]] as const) {
    const response = await handlePlanRequest(new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    assert.equal(response.status, expected);
  }
});

test("API blocks cross-origin posts", async () => {
  const response = await handlePlanRequest(new Request("http://localhost/api/plan", { method: "POST", headers: { Origin: "https://unrelated.example", "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 403);
});

test("successful API responses expose operational request metadata", async () => {
  const response = await handlePlanRequest(new Request("http://localhost/api/plan", {
    method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "test-success" },
    body: JSON.stringify({ question: "Does it fit?", moduleIds: ["maths"], headroom: 0.2 }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
  assert.match(response.headers.get("server-timing") || "", /^total;dur=/);
  const payload = await response.json() as { calculation: { fits: boolean }; mode: string };
  assert.equal(payload.calculation.fits, true);
  assert.equal(payload.mode, "catalog");
});

test("planning endpoint enforces its bounded local request limit", async () => {
  const previous = process.env.RACKWISE_RATE_LIMIT_PER_MINUTE;
  process.env.RACKWISE_RATE_LIMIT_PER_MINUTE = "5";
  try {
    let response: Response | undefined;
    for (let index = 0; index < 6; index += 1) {
      response = await handlePlanRequest(new Request("http://localhost/api/plan", {
        method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "rate-limit-test" }, body: "{}",
      }));
    }
    assert.equal(response?.status, 429);
    assert.equal(response?.headers.get("ratelimit-remaining"), "0");
    assert.ok(Number(response?.headers.get("retry-after")) >= 1);
  } finally {
    if (previous === undefined) delete process.env.RACKWISE_RATE_LIMIT_PER_MINUTE;
    else process.env.RACKWISE_RATE_LIMIT_PER_MINUTE = previous;
  }
});

test("SSE reads the matching tool result rather than a progress notification", () => {
  const raw = 'data: {"method":"notifications/progress"}\n\ndata: {"id":"expected","result":{"content":[{"type":"text","text":"evidence"}]}}\n\n';
  assert.equal(parseRpcResponse(raw, "expected").result?.content?.[0].text, "evidence");
  assert.throws(() => parseRpcResponse('{"id":"expected","result":{"isError":true}}', "expected"));
});

test("knowledge paths stay inside the chosen Knowledge Base", () => {
  const outline = "Knowledge base id: kbFirst\n- modules/maths [core]\nKnowledge base id: kbSecond\n- cases/power [core]\n";
  assert.deepEqual(selectKnowledgePaths(outline, ["Maths"], "Check power", "kbFirst"), ["modules/maths"]);
});

test("knowledge path selection keeps the best available entry for each selected module", () => {
  const outline = "Knowledge base id: kbFirst\n- modules/function_generators/maths [core]\n- modules/samplers/morphagene [core]\n- compatibility/power_and_wiring [core]\n";
  assert.deepEqual(
    selectKnowledgePaths(outline, ["MATHS", "Morphagene"], "Check power", "kbFirst"),
    ["modules/function_generators/maths", "modules/samplers/morphagene", "compatibility/power_and_wiring"],
  );
});

test("catalog modules route to semantic entries without relying on question wording", () => {
  const outline = "Knowledge base id: kbFirst\n- compatibility/physical_fitment [core]\n- compatibility/power_and_wiring [core]\n- modules/envelopes_and_modulators [core]\n- modules/granular_and_tape [core]\n- modules/sequencers_and_controllers [core]\n- modules/oscillators_and_sound_sources/plaits [core]\n";
  assert.deepEqual(
    selectKnowledgePaths(outline, ["MATHS", "Pamela's PRO", "Morphagene", "Disting EX", "Plaits"], "Check source coverage.", "kbFirst"),
    ["modules/envelopes_and_modulators", "modules/sequencers_and_controllers", "modules/granular_and_tape", "compatibility/physical_fitment", "modules/oscillators_and_sound_sources/plaits", "compatibility/power_and_wiring"],
  );
});

test("knowledge path selection includes top-level Knowledge Base entries", () => {
  const outline = "Knowledge base id: kbFirst\ncompatibility/physical_fitment [core]\nmidi_and_cv_control\n  MIDI tools and physical specs\n";
  assert.deepEqual(selectKnowledgePaths(outline, ["Disting EX"], "Check MIDI control", "kbFirst"), ["compatibility/physical_fitment", "midi_and_cv_control"]);
});

test("current Rackwise outline routes Disting EX and Plaits to specification entries", () => {
  const outline = "Knowledge base id: kbFirst\ncases_and_power [core]\nmodule_compatibility [core]\noscillators_and_synthesis/plaits/firmware\noscillators_and_synthesis/plaits/overview [core]\n";
  assert.deepEqual(
    selectKnowledgePaths(outline, ["Disting EX", "Plaits"], "Check fit and power", "kbFirst"),
    ["module_compatibility", "oscillators_and_synthesis/plaits/overview", "cases_and_power"],
  );
});

test("evidence claims are compared against catalog facts without overwriting them", () => {
  const facts: CatalogFact[] = [{ key: "maths.depth", subject: "MATHS", property: "depth", value: 32, unit: "mm", displayValue: "32 mm" }];
  const assessment = createEvidenceAssessment({
    evidence: "# MATHS\nDepth: 24 mm\nSource: https://maker.example/maths",
    paths: ["modules/maths"], catalogFacts: facts,
    model: { answer: "Review the depth.", gaps: [], claims: [{
      subject: "MATHS", property: "depth", displayValue: "24 mm", normalizedValue: 24, unit: "mm",
      catalogKey: "maths.depth", sourceTitle: "Maker manual", sourceUrl: "https://maker.example/maths",
      knowledgePath: "modules/maths", statement: "The manual lists a 24 mm depth.",
    }] },
  });
  assert.equal(assessment.decision.status, "conflict");
  assert.equal(assessment.decision.blocking, true);
  assert.equal(assessment.claims[0].catalogValue, "32 mm");
  assert.equal(assessment.claims[0].status, "conflicts");
});

test("unsupported model citations are discarded from the evidence contract", () => {
  const assessment = createEvidenceAssessment({
    evidence: "No links here.", paths: ["modules/maths"], catalogFacts: [],
    model: { answer: "Unverified.", gaps: ["Official depth"], claims: [{
      subject: "MATHS", property: "depth", displayValue: "24 mm", normalizedValue: 24, unit: "mm",
      catalogKey: null, sourceTitle: "Invented source", sourceUrl: "https://invented.example/maths",
      knowledgePath: "not/a/real/path", statement: "An unsupported statement.",
    }] },
  });
  assert.equal(assessment.claims.length, 0);
  assert.equal(assessment.decision.status, "insufficient");
  assert.deepEqual(assessment.gaps, ["Official depth"]);
});

test("a model cannot turn a catalog source into retrieved Knowledge Base evidence", () => {
  const assessment = createEvidenceAssessment({
    evidence: "# Different entry\nNo MATHS specification is present.",
    paths: ["modules/different-entry"],
    catalogFacts: [{ key: "maths.width", subject: "MATHS", property: "width", value: 20, unit: "HP", displayValue: "20 HP" }],
    coverageTargets: [{ key: "maths", subject: "MATHS", kind: "module" }],
    model: { answer: "MATHS is 20 HP.", gaps: [], claims: [{
      subject: "MATHS", property: "width", displayValue: "20 HP", normalizedValue: 20, unit: "HP",
      catalogKey: "maths.width", sourceTitle: "Catalog URL", sourceUrl: "https://maker.example/maths",
      knowledgePath: null, statement: "MATHS is 20 HP wide.",
    }] },
  });
  assert.equal(assessment.claims.length, 0);
  assert.equal(assessment.coverage.verifiedModules, 0);
});

test("model assessment parser accepts safe formatting variants", () => {
  const parsed = parseModelAssessment(JSON.stringify({
    summary: "The documented depth agrees.",
    claims: [{
      subject: "MATHS", property: "module_depth", display_value: "32 mm", normalized_value: "32", unit: "mm",
      catalog_key: "maths.depth", source_title: "MATHS", source_url: "https://maker.example/maths",
      knowledge_path: "modules/maths", statement: "The source lists a 32 mm depth.",
    }],
    gaps: [],
  }));
  assert.equal(parsed.answer, "The documented depth agrees.");
  assert.equal(parsed.claims[0].property, "depth");
  assert.equal(parsed.claims[0].normalizedValue, 32);
  assert.equal(parsed.claims[0].sourceUrl, "https://maker.example/maths");
});

test("analysis failure is distinguished from missing Knowledge Base evidence", () => {
  const assessment = createEvidenceAssessment({
    analysisFailed: true, evidence: "Retrieved evidence", paths: ["modules/maths"], catalogFacts: [], model: null,
  });
  assert.equal(assessment.decision.status, "insufficient");
  assert.match(assessment.decision.summary, /analysis could not be completed/i);
});

test("structured evidence stays supported when optional AI synthesis fails", () => {
  const assessment = createEvidenceAssessment({
    analysisFailed: true,
    evidence: "# MATHS\nWidth: 20 HP.",
    paths: ["modules/maths"],
    catalogFacts: [{ key: "maths.width", subject: "MATHS", property: "width", value: 20, unit: "HP", displayValue: "20 HP" }],
    coverageTargets: [{ key: "maths", subject: "MATHS", kind: "module" }],
    model: { answer: "Structured fallback.", gaps: [], claims: [{
      subject: "MATHS", property: "width", displayValue: "20 HP", normalizedValue: 20, unit: "HP",
      catalogKey: "maths.width", sourceTitle: "MATHS", sourceUrl: null,
      knowledgePath: "modules/maths", statement: "MATHS is 20 HP wide.",
    }] },
  });
  assert.equal(assessment.decision.status, "supported");
  assert.match(assessment.decision.basis, /structured knowledge base claims align/i);
  assert.match(assessment.decision.basis, /AI synthesis did not complete/i);
});

test("model evidence is bounded while retaining entry sources", () => {
  const longEntry = "# Module\n" + "specification detail\n".repeat(2000) + "\n## Sources\n1. https://maker.example/module";
  const compacted = compactEvidenceForModel(longEntry, 3000)!;
  assert.ok(compacted.length <= 3000);
  assert.match(compacted, /# Module/);
  assert.match(compacted, /https:\/\/maker\.example\/module/);
  assert.match(compacted, /Additional entry detail omitted/);
});

test("partial evidence reports module coverage without implying every module was verified", () => {
  const facts: CatalogFact[] = [
    { key: "case.width", subject: "Case", property: "width", value: 104, unit: "HP", displayValue: "104 HP" },
    { key: "maths.width", subject: "MATHS", property: "width", value: 20, unit: "HP", displayValue: "20 HP" },
  ];
  const assessment = createEvidenceAssessment({
    evidence: "# TPS80W power\nWidth: 104 HP", paths: ["compatibility/power"], catalogFacts: facts,
    coverageTargets: [{ key: "case", subject: "Case", kind: "case" }, { key: "maths", subject: "MATHS", kind: "module" }],
    model: { answer: "Everything agrees.", gaps: [], claims: [{
      subject: "Case", property: "width", displayValue: "104 HP", normalizedValue: 104, unit: "HP",
      catalogKey: "case.width", sourceTitle: "Case manual", sourceUrl: null,
      knowledgePath: "compatibility/power", statement: "The case is 104 HP wide.",
    }] },
  });
  assert.equal(assessment.coverage.caseVerified, true);
  assert.equal(assessment.coverage.verifiedModules, 0);
  assert.equal(assessment.coverage.totalModules, 1);
  assert.equal(assessment.decision.status, "partial");
  assert.match(assessment.decision.summary, /0 of 1 verified/i);
  assert.ok(assessment.gaps.includes("No validated Knowledge Base claim was returned for MATHS."));
});

test("coverage-aware explanation does not repeat a model's unsupported full-agreement claim", () => {
  const calculation = calculatePlan(["maths"]);
  const assessment = createEvidenceAssessment({
    evidence: "# TPS80W power\nWidth: 104 HP", paths: ["compatibility/power"],
    catalogFacts: [{ key: "case.width", subject: "Case", property: "width", value: 104, unit: "HP", displayValue: "104 HP" }],
    coverageTargets: [{ key: "case", subject: "Case", kind: "case" }, { key: "maths", subject: "MATHS", kind: "module" }],
    model: { answer: "Every module agrees.", gaps: [], claims: [{
      subject: "Case", property: "width", displayValue: "104 HP", normalizedValue: 104, unit: "HP", catalogKey: "case.width",
      sourceTitle: "Case manual", sourceUrl: null, knowledgePath: "compatibility/power", statement: "The case is 104 HP wide.",
    }] },
  });
  const explanation = createCoverageAwareExplanation(calculation, 0.2, assessment);
  assert.doesNotMatch(explanation, /every module agrees/i);
  assert.match(explanation, /could not match a validated source claim for MATHS/i);
});

test("structured Knowledge Base tables yield deterministic cited claims", () => {
  const evidence = "# Pamela's PRO Workout\n\n**Size:** 8HP | **Depth:** 32mm\n**Power:** +12V 60mA / -12V 10mA\n\n## Sources\n1. ALM — Web · https://maker.example/pams\n\n---\n\n# Power\n\n| Model | +12V | −12V | +5V |\n|---|---|---|---|\n| TPS80W | 3000 mA | 3000 mA | 1500 mA |\n\n## Sources\n1. Manual — Web · https://maker.example/tps";
  const facts: CatalogFact[] = [
    { key: "pams-pro.width", subject: "Pamela's PRO", property: "width", value: 8, unit: "HP", displayValue: "8 HP" },
    { key: "pams-pro.depth", subject: "Pamela's PRO", property: "depth", value: 32, unit: "mm", displayValue: "32 mm" },
    { key: "pams-pro.plus12", subject: "Pamela's PRO", property: "plus12", value: 60, unit: "mA", displayValue: "60 mA" },
    { key: "pams-pro.minus12", subject: "Pamela's PRO", property: "minus12", value: 10, unit: "mA", displayValue: "10 mA" },
    { key: "case.plus12", subject: "104 HP · TPS80W profile", property: "plus12", value: 3000, unit: "mA", displayValue: "3000 mA" },
    { key: "case.minus12", subject: "104 HP · TPS80W profile", property: "minus12", value: 3000, unit: "mA", displayValue: "3000 mA" },
    { key: "case.plus5", subject: "104 HP · TPS80W profile", property: "plus5", value: 1500, unit: "mA", displayValue: "1500 mA" },
  ];
  const claims = extractStructuredClaims({ evidence, paths: ["modules/sequencers", "compatibility/power"], catalogFacts: facts });
  assert.equal(claims.length, 7);
  assert.ok(claims.every((claim) => claim.sourceUrl?.startsWith("https://maker.example/")));
  assert.ok(claims.some((claim) => claim.catalogKey === "pams-pro.depth" && claim.knowledgePath === "modules/sequencers"));
  assert.ok(claims.some((claim) => claim.catalogKey === "case.plus5" && claim.knowledgePath === "compatibility/power"));
});

test("structured extraction prefers URLs from the Sources block", () => {
  const claims = extractStructuredClaims({
    evidence: "# Morphagene\nWidth: 20 HP\nCommunity audio: https://unrelated.example/reels\n\n## Sources\n1. Official - Web · https://maker.example/morphagene",
    paths: ["patching_techniques/granular_tape_modules"],
    catalogFacts: [{ key: "morphagene.width", subject: "Morphagene", property: "width", value: 20, unit: "HP", displayValue: "20 HP" }],
  });
  assert.equal(claims[0].sourceUrl, "https://maker.example/morphagene");
});

test("Plaits specifications prefer the overview over a partial compatibility entry", () => {
  const claims = extractStructuredClaims({
    evidence: "# Module compatibility\nPlaits power: +12V 50mA / -12V 5mA\n\n## Sources\nhttps://seller.example/disting-nt\n\n---\n\n# Plaits overview\nWidth: 12HP\nDepth: 25mm\nPower: +12V 50mA / -12V 5mA\n\n## Sources\nhttps://pichenettes.github.io/mutable-instruments-documentation/modules/plaits/",
    paths: ["module_compatibility", "oscillators_and_synthesis/plaits/overview"],
    catalogFacts: [
      { key: "plaits.width", subject: "Plaits", property: "width", value: 12, unit: "HP", displayValue: "12 HP" },
      { key: "plaits.depth", subject: "Plaits", property: "depth", value: 25, unit: "mm", displayValue: "25 mm" },
      { key: "plaits.plus12", subject: "Plaits", property: "plus12", value: 50, unit: "mA", displayValue: "50 mA" },
      { key: "plaits.minus12", subject: "Plaits", property: "minus12", value: 5, unit: "mA", displayValue: "5 mA" },
    ],
  });
  assert.equal(claims.length, 4);
  assert.ok(claims.every((claim) => claim.knowledgePath === "oscillators_and_synthesis/plaits/overview"));
  assert.ok(claims.every((claim) => claim.sourceUrl?.includes("mutable-instruments-documentation")));
});

test("Disting EX claims never inherit a Disting NT seller URL", () => {
  const claims = extractStructuredClaims({
    evidence: "# Module compatibility\n| Module | Width | Depth | +12V | -12V |\n| Disting EX | 8 HP | 50 mm | 229 mA | 50 mA |\n\n## Sources\n1. Disting NT - https://seller.example/disting-nt\n2. disting-ex-official-specifications.md - File",
    paths: ["module_compatibility"],
    catalogFacts: [{ key: "disting-ex.width", subject: "Disting EX", property: "width", value: 8, unit: "HP", displayValue: "8 HP" }],
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].sourceUrl, null);
});

test("case recommendations can support the planning-profile width", () => {
  const claims = extractStructuredClaims({
    evidence: "# TPS80W\nManufacturer recommendation: cases up to 7U × 104HP\n\n## Sources\nhttps://maker.example/tps80w",
    paths: ["cases_and_power"],
    catalogFacts: [{ key: "case.width", subject: "104 HP · TPS80W profile", property: "width", value: 104, unit: "HP", displayValue: "104 HP" }],
  });
  assert.equal(claims.length, 1);
});

test("power rail extraction keeps each current attached to the correct rail", () => {
  const evidence = "# Module\nPower: +12V 60mA / -12V 10mA";
  const claims = extractStructuredClaims({
    evidence,
    paths: ["modules/test"],
    catalogFacts: [
      { key: "module.plus12", subject: "Module", property: "plus12", value: 10, unit: "mA", displayValue: "10 mA" },
      { key: "module.minus12", subject: "Module", property: "minus12", value: 60, unit: "mA", displayValue: "60 mA" },
    ],
  });
  assert.equal(claims.length, 0);
});

test("structured sections map to their semantic path when returned paths and sections differ", () => {
  const evidence = "# Pamela's PRO Workout\n\n**Size:** 8HP | **Depth:** 32mm\n\n---\n\n# Morphagene — Granular and Tape\n\n**Width:** 20HP | **Depth:** 45mm";
  const facts: CatalogFact[] = [
    { key: "pams-pro.width", subject: "Pamela's PRO", property: "width", value: 8, unit: "HP", displayValue: "8 HP" },
    { key: "morphagene.width", subject: "Morphagene", property: "width", value: 20, unit: "HP", displayValue: "20 HP" },
  ];
  const claims = extractStructuredClaims({
    evidence,
    paths: ["firmware_and_calibration", "modules/granular_and_tape", "modules/sequencers_and_controllers"],
    catalogFacts: facts,
  });
  assert.equal(claims.find((claim) => claim.catalogKey === "pams-pro.width")?.knowledgePath, "modules/sequencers_and_controllers");
  assert.equal(claims.find((claim) => claim.catalogKey === "morphagene.width")?.knowledgePath, "modules/granular_and_tape");
});

test("structured extraction never treats Disting NT evidence as Disting EX", () => {
  const facts: CatalogFact[] = [{ key: "disting-ex.width", subject: "Disting EX", property: "width", value: 8, unit: "HP", displayValue: "8 HP" }];
  const structured = extractStructuredClaims({
    evidence: "# Physical fitment\n\nThe Disting NT is 22HP wide.\n\n## Sources\nhttps://maker.example/disting-nt",
    paths: ["compatibility/physical_fitment"], catalogFacts: facts,
  });
  assert.equal(structured.length, 0);
  const combined = combineEvidenceClaims(null, structured);
  assert.equal(combined, null);
});

test("variant mismatches are surfaced instead of generic missing evidence", () => {
  const assessment = createEvidenceAssessment({
    evidence: "Disting NT is 22HP wide.", paths: ["compatibility/physical_fitment"], catalogFacts: [], model: null,
    coverageTargets: [{ key: "disting-ex", subject: "Disting EX", kind: "module", mismatch: "The Knowledge Base describes Disting NT, not Disting EX." }],
  });
  assert.equal(assessment.coverage.targets[0].status, "variant_mismatch");
  assert.deepEqual(assessment.gaps, ["The Knowledge Base describes Disting NT, not Disting EX."]);
});

test("variant mismatch explanation is clear about what was not verified", () => {
  const calculation = calculatePlan(["maths", "disting-ex"], 0.2);
  const assessment = createEvidenceAssessment({
    evidence: "# MATHS\nWidth: 20 HP\n\n---\n\n# Disting NT\nDisting NT is documented here.", paths: ["modules/maths", "compatibility/physical_fitment"],
    catalogFacts: [{ key: "maths.width", subject: "MATHS", property: "width", value: 20, unit: "HP", displayValue: "20 HP" }],
    model: { answer: "Source check.", gaps: [], claims: [{
      subject: "MATHS", property: "width", displayValue: "20 HP", normalizedValue: 20, unit: "HP", catalogKey: "maths.width",
      sourceTitle: "MATHS", sourceUrl: null, knowledgePath: "modules/maths", statement: "MATHS is 20 HP wide.",
    }] },
    coverageTargets: [
      { key: "case", subject: "Case", kind: "case" },
      { key: "maths", subject: "MATHS", kind: "module" },
      { key: "disting-ex", subject: "Disting EX", kind: "module", mismatch: "The Knowledge Base covers Disting NT." },
    ],
  });
  const explanation = createCoverageAwareExplanation(calculation, 0.2, assessment);
  assert.match(explanation, /this rack contains Disting EX, while the retrieved entry is for Disting NT/i);
  assert.match(explanation, /did not use the NT measurements to verify the EX/i);
  assert.doesNotMatch(explanation, /did not receive a matching validated module claim/i);
});
