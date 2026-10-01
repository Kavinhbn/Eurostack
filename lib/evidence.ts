import type { EvidenceAssessment, EvidenceClaim, EvidenceProperty } from "./contracts.ts";
import type { ModelAssessment, ModelEvidenceClaim } from "./model.ts";

export type CatalogFact = {
  key: string;
  subject: string;
  property: EvidenceProperty;
  value: number;
  unit: string;
  displayValue: string;
};

export type CoverageTarget = {
  key: string;
  subject: string;
  kind: "case" | "module";
  mismatch?: string;
};

function extractUrls(value: string) {
  return [...value.matchAll(/https?:\/\/[^\s)>\]}]+/g)].map((match) => match[0].replace(/[.,;:]+$/, ""));
}

function sourceUrls(section: string) {
  const sourcesAt = section.search(/^## Sources\s*$/im);
  const sourceBlock = sourcesAt >= 0 ? section.slice(sourcesAt) : section;
  return extractUrls(sourceBlock);
}

function sourceUrlForSubject(subject: string, section: string) {
  const urls = sourceUrls(section);
  const normalized = normalizedText(subject);
  if (normalized.includes("disting ex")) return urls.find((url) => /disting[_/-]?ex/i.test(url)) || null;
  if (normalized.includes("plaits")) return urls.find((url) => /\/modules\/plaits\/?$/i.test(url)) || urls.find((url) => /\/plaits(?:\/|$)/i.test(url)) || null;
  return urls[0] || null;
}

function preferredSectionScore(target: string, section: { text: string; path: string | null }) {
  const path = section.path || "";
  if (target === "case" && /cases_and_power$|power_and_wiring$/i.test(path)) return 20;
  if (target === "plaits" && /plaits\/overview$/i.test(path)) return 20;
  if (target === "disting-ex" && /module_compatibility$|disting[_/-]?ex/i.test(path)) return 20;
  return 0;
}

function sameUnit(left: string | null, right: string) {
  return Boolean(left) && left!.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizedText(value: string) {
  return value.toLowerCase().replace(/[’']/g, " ").replace(/[^a-z0-9+.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function markdownTitle(section: string, fallback: string) {
  return section.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function pathForSection(section: string, paths: string[]) {
  const text = normalizedText(section);
  const title = normalizedText(markdownTitle(section, ""));
  const semanticRoutes: Array<[RegExp, RegExp]> = [
    [/\b(module physical electrical compatibility|module compatibility|physical fitment)\b/, /module_compatibility$|physical|fitment/i],
    [/\bplaits\b/, /plaits\/overview$|plaits$/i],
    [/\b(tps80w|power requirements|power and wiring)\b/, /power|wiring/i],
    [/\b(maths|envelopes functions and modulators)\b/, /envelope|modulator|maths/i],
    [/\b(morphagene|granular and tape)\b/, /granular|tape|morphagene/i],
    [/\b(pamela|sequencers controllers and clocking)\b/, /sequencer|controller|clock|pamela/i],
    [/\b(disting ex|disting nt)\b/, /module_compatibility$|disting|physical|fitment/i],
    [/\bmidi\b/, /midi/i],
    [/\b(firmware|calibration)\b/, /firmware|calibration/i],
  ];
  for (const [sectionPattern, pathPattern] of semanticRoutes) {
    if (!sectionPattern.test(title + " " + text.slice(0, 1200))) continue;
    const matched = paths.find((path) => pathPattern.test(path));
    if (matched) return matched;
  }
  const ranked = paths.map((path) => {
    const tokens = path.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
    return { path, score: tokens.reduce((score, token) => score + (title.includes(token) ? 4 : text.includes(token) ? 1 : 0), 0) };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.score > 0 ? ranked[0].path : null;
}

function valuePattern(value: number, unit: string) {
  return new RegExp("(?:^|[^0-9.])" + String(value).replace(".", "\\.") + "\\s*" + unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|[^a-z])", "i");
}

function labelAndValuePattern(label: string, value: number, unit: string) {
  const escapedValue = String(value).replace(".", "\\.");
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const between = "[^0-9/\\n\\r]";
  return new RegExp("(?:" + label + ")" + between + "{0,40}" + escapedValue + "\\s*" + escapedUnit + "|" + escapedValue + "\\s*" + escapedUnit + between + "{0,20}(?:" + label + ")", "i");
}

function lineSupportsFact(line: string, fact: CatalogFact) {
  const plain = line.replace(/−/g, "-");
  if (!valuePattern(fact.value, fact.unit).test(plain)) return false;
  if (fact.property === "width") {
    if (fact.key.startsWith("case.") && new RegExp("(?:\\bcases?\\s+up\\s+to|recommended\\s+case\\s+size)[^\\n]{0,40}\\b" + String(fact.value).replace(".", "\\.") + "\\s*hp\\b", "i").test(plain)) return true;
    return labelAndValuePattern("\\b(?:width|size|panel width)\\b", fact.value, "hp").test(plain);
  }
  if (fact.property === "depth") return labelAndValuePattern("\\bdepth\\b", fact.value, "mm").test(plain);
  if (fact.property === "plus12") return labelAndValuePattern("\\+\\s*12\\s*v", fact.value, "ma").test(plain);
  if (fact.property === "minus12") return labelAndValuePattern("-\\s*12\\s*v", fact.value, "ma").test(plain);
  if (fact.property === "plus5") return labelAndValuePattern("\\+\\s*5\\s*v", fact.value, "ma").test(plain);
  return false;
}

function tpsPowerValue(section: string, property: EvidenceProperty) {
  const lines = section.split("\n");
  const headerIndex = lines.findIndex((line) => {
    const plain = line.replace(/−/g, "-");
    return /\|\s*model\s*\|/i.test(plain) && /\+12v/i.test(plain) && /-12v/i.test(plain) && /\+5v/i.test(plain);
  });
  if (headerIndex < 0) return null;
  const headers = lines[headerIndex].split("|").map((cell) => cell.trim().toLowerCase()).filter(Boolean);
  const row = lines.slice(headerIndex + 1).find((line) => /\|\s*tps80w\s*\|/i.test(line));
  if (!row) return null;
  const values = row.split("|").map((cell) => cell.trim()).filter(Boolean);
  const label = property === "plus12" ? "+12v" : property === "minus12" ? "-12v" : property === "plus5" ? "+5v" : "";
  const index = headers.findIndex((header) => normalizedText(header.replace(/−/g, "-")) === label);
  const match = index >= 0 ? values[index]?.match(/([0-9.]+)\s*mA/i) : null;
  return match ? Number(match[1]) : null;
}

function moduleTableValue(section: string, subject: string, property: EvidenceProperty) {
  const lines = section.split("\n");
  const headerIndex = lines.findIndex((line) => {
    const plain = line.replace(/−/g, "-");
    return /\|\s*module\s*\|/i.test(plain) && /\bwidth\b/i.test(plain) && /\bdepth\b/i.test(plain);
  });
  if (headerIndex < 0) return null;
  const headers = lines[headerIndex].split("|").map((cell) => normalizedText(cell.replace(/−/g, "-"))).filter(Boolean);
  const subjectNeedle = normalizedText(subject);
  const row = lines.slice(headerIndex + 1).find((line) => normalizedText(line).includes(subjectNeedle));
  if (!row) return null;
  const values = row.split("|").map((cell) => cell.trim()).filter(Boolean);
  const label = property === "width" ? "width" : property === "depth" ? "depth" : property === "plus12" ? "+12v" : property === "minus12" ? "-12v" : property === "plus5" ? "+5v" : "";
  const index = headers.findIndex((header) => header === label);
  const unit = property === "width" ? "hp" : property === "depth" ? "mm" : "ma";
  const match = index >= 0 ? values[index]?.replace(/−/g, "-").match(new RegExp("([0-9.]+)\\s*" + unit, "i")) : null;
  return match ? Number(match[1]) : null;
}

export function extractStructuredClaims(options: {
  evidence: string | null;
  paths: string[];
  catalogFacts: CatalogFact[];
}) {
  if (!options.evidence) return [] as ModelEvidenceClaim[];
  const sections = options.evidence.split(/\n\s*---\s*\n/g).map((text) => ({ text, path: pathForSection(text, options.paths) }));
  const factsByTarget = new Map<string, CatalogFact[]>();
  for (const fact of options.catalogFacts) {
    const target = fact.key.split(".")[0];
    factsByTarget.set(target, [...(factsByTarget.get(target) || []), fact]);
  }
  const extracted: ModelEvidenceClaim[] = [];
  for (const [target, facts] of factsByTarget) {
    const subject = facts[0].subject;
    const subjectNeedle = target === "case" ? "tps80w" : normalizedText(subject);
    const subjectSections = sections
      .filter((candidate) => normalizedText(candidate.text).includes(subjectNeedle))
      .sort((left, right) => preferredSectionScore(target, right) - preferredSectionScore(target, left));
    for (const fact of facts) {
      const section = subjectSections.find((candidate) => candidate.text.split("\n").some((line) => lineSupportsFact(line, fact))
        || moduleTableValue(candidate.text, subject, fact.property) === fact.value
        || (target === "case" && tpsPowerValue(candidate.text, fact.property) === fact.value));
      if (!section) continue;
      const sourceUrl = sourceUrlForSubject(subject, section.text);
      const sourceTitle = markdownTitle(section.text, subject);
      const directLine = section.text.split("\n").find((line) => lineSupportsFact(line, fact));
      const tableValue = target === "case" ? tpsPowerValue(section.text, fact.property) : moduleTableValue(section.text, subject, fact.property);
      const supported = Boolean(directLine) || (tableValue !== null && Math.abs(tableValue - fact.value) < 0.001);
      if (!supported) continue;
      extracted.push({
        subject,
        property: fact.property,
        displayValue: fact.displayValue,
        normalizedValue: fact.value,
        unit: fact.unit,
        catalogKey: fact.key,
        sourceTitle,
        sourceUrl,
        knowledgePath: section.path,
        statement: "The structured Knowledge Base entry lists " + subject + " " + fact.property.replace("plus12", "+12V current").replace("minus12", "−12V current").replace("plus5", "+5V current") + " as " + fact.displayValue + ".",
      });
    }
  }
  return extracted;
}

export function combineEvidenceClaims(model: ModelAssessment | null, structured: ModelEvidenceClaim[]) {
  if (!model && !structured.length) return null;
  const seen = new Set<string>();
  const claims = [...structured, ...(model?.claims || [])].filter((claim) => {
    const key = claim.catalogKey || normalizedText(claim.subject) + "::" + claim.property + "::" + claim.displayValue;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
  const coveredSubjects = new Set(structured.map((claim) => normalizedText(claim.subject)));
  const gaps = (model?.gaps || []).filter((gap) => ![...coveredSubjects].some((subject) => normalizedText(gap).includes(subject)));
  return { answer: model?.answer || "Structured source-backed specifications were extracted from the retrieved Knowledge Base entries.", claims, gaps } satisfies ModelAssessment;
}

export function createEvidenceAssessment(options: {
  model: ModelAssessment | null;
  analysisFailed?: boolean;
  evidence: string | null;
  paths: string[];
  catalogFacts: CatalogFact[];
  coverageTargets?: CoverageTarget[];
}): EvidenceAssessment {
  const { model, analysisFailed = false, evidence, paths, catalogFacts, coverageTargets = [] } = options;
  const allowedUrls = new Set(extractUrls(evidence || ""));
  const allowedPaths = new Set(paths);
  const facts = new Map(catalogFacts.map((fact) => [fact.key, fact]));
  const evidenceSections = (evidence || "").split(/\n\s*---\s*\n/g).map((text) => ({ text, path: pathForSection(text, paths), urls: new Set(extractUrls(text)) }));
  const candidates = (model?.claims || []).filter((claim) => {
    const fact = claim.catalogKey ? facts.get(claim.catalogKey) : undefined;
    if (!fact || claim.normalizedValue === null || !claim.unit || !sameUnit(claim.unit, fact.unit)) return false;
    const claimedFact = { ...fact, value: claim.normalizedValue, unit: claim.unit };
    return evidenceSections.some((section) => {
      const sourceMatches = Boolean(claim.sourceUrl && section.urls.has(claim.sourceUrl));
      const pathMatches = Boolean(claim.knowledgePath && section.path === claim.knowledgePath && allowedPaths.has(claim.knowledgePath));
      if (!sourceMatches && !pathMatches) return false;
      const subjectNeedle = claim.catalogKey?.startsWith("case.") ? "tps80w" : normalizedText(fact.subject);
      if (!normalizedText(section.text).includes(subjectNeedle)) return false;
      return section.text.split("\n").some((line) => lineSupportsFact(line, claimedFact))
        || moduleTableValue(section.text, fact.subject, fact.property) === claim.normalizedValue
        || (claim.catalogKey?.startsWith("case.") && tpsPowerValue(section.text, fact.property) === claim.normalizedValue);
    });
  }).slice(0, 40);

  const groups = new Map<string, typeof candidates>();
  for (const claim of candidates) {
    const key = claim.subject.trim().toLowerCase() + "::" + claim.property;
    groups.set(key, [...(groups.get(key) || []), claim]);
  }

  const claims: EvidenceClaim[] = candidates.map((claim) => {
    const fact = claim.catalogKey ? facts.get(claim.catalogKey) : undefined;
    const peers = groups.get(claim.subject.trim().toLowerCase() + "::" + claim.property) || [];
    const peerValues = peers
      .filter((peer) => peer.normalizedValue !== null && peer.unit && claim.unit && peer.unit.toLowerCase() === claim.unit.toLowerCase())
      .map((peer) => peer.normalizedValue as number);
    const distinctValues = new Set(peerValues.map((value) => value.toFixed(4)));
    const groupConflict = distinctValues.size > 1;
    const comparesToCatalog = Boolean(fact && claim.normalizedValue !== null && sameUnit(claim.unit, fact.unit));
    const agreesWithCatalog = comparesToCatalog && Math.abs((claim.normalizedValue as number) - fact!.value) < 0.001;
    const conflictsWithCatalog = comparesToCatalog && !agreesWithCatalog;
    const status = groupConflict || conflictsWithCatalog ? "conflicts" : agreesWithCatalog ? "agrees" : "unverified";
    return {
      id: crypto.randomUUID(),
      subject: claim.subject,
      property: claim.property,
      displayValue: claim.displayValue,
      normalizedValue: claim.normalizedValue,
      unit: claim.unit,
      catalogKey: fact?.key || null,
      catalogValue: fact?.displayValue || null,
      sourceTitle: claim.sourceTitle,
      sourceUrl: claim.sourceUrl && allowedUrls.has(claim.sourceUrl) ? claim.sourceUrl : null,
      knowledgePath: claim.knowledgePath && allowedPaths.has(claim.knowledgePath) ? claim.knowledgePath : null,
      statement: claim.statement,
      status,
    };
  });

  const conflicts = claims.filter((claim) => claim.status === "conflicts");
  const coverage = coverageTargets.map((target) => {
    const targetClaims = claims.filter((claim) => claim.catalogKey?.startsWith(target.key + "."));
    const targetFacts = catalogFacts.filter((fact) => fact.key.startsWith(target.key + "."));
    const requiredProperties = new Set(targetFacts
      .filter((fact) => target.kind === "case"
        ? fact.property === "width" || (["plus12", "minus12", "plus5"].includes(fact.property) && fact.value > 0)
        : fact.property === "width" || fact.property === "depth" || (["plus12", "minus12", "plus5"].includes(fact.property) && fact.value > 0))
      .map((fact) => fact.property));
    const alignedProperties = new Set(targetClaims.filter((claim) => claim.status === "agrees").map((claim) => claim.property));
    const missingProperties = [...requiredProperties].filter((property) => !alignedProperties.has(property));
    const propertyLabels: Record<string, string> = { width: "width", depth: "depth", plus12: "+12V draw", minus12: "−12V draw", plus5: "+5V draw" };
    const status = targetClaims.some((claim) => claim.status === "conflicts")
      ? "conflict" as const
      : requiredProperties.size > 0 && missingProperties.length === 0
        ? "aligned" as const
        : targetClaims.length
          ? "unverified" as const
          : target.mismatch
            ? "variant_mismatch" as const
          : "missing" as const;
    const note = target.mismatch || (missingProperties.length ? "Still needs source-backed " + missingProperties.map((property) => propertyLabels[property]).join(", ") + "." : null);
    return { key: target.key, subject: target.subject, kind: target.kind, status, claimCount: targetClaims.length, note };
  });
  const moduleCoverage = coverage.filter((target) => target.kind === "module");
  const caseCoverage = coverage.find((target) => target.kind === "case");
  const automaticGaps = coverage
    .filter((target) => target.kind === "module" && (target.status === "missing" || target.status === "unverified" || target.status === "variant_mismatch"))
    .map((target) => target.status === "missing"
      ? "No validated Knowledge Base claim was returned for " + target.subject + "."
      : target.status === "variant_mismatch"
        ? target.note || "The Knowledge Base describes a different variant of " + target.subject + "."
      : target.note || "The retrieved claims for " + target.subject + " do not yet cover every fit and powered rail used by this decision.");
  const gaps = [...new Set([...(model?.gaps || []), ...automaticGaps])].slice(0, 12);
  const verifiedModules = moduleCoverage.filter((target) => target.status === "aligned").length;
  const completeCoverage = coverage.length > 0 && coverage.every((target) => target.status === "aligned");
  const status = !evidence
    ? "catalog_only"
    : conflicts.length
      ? "conflict"
      : claims.length
        ? coverage.length && !completeCoverage ? "partial" : "supported"
        : "insufficient";
  const blocking = conflicts.some((claim) => ["width", "depth", "plus12", "minus12", "plus5"].includes(claim.property));
  const confidence = status === "supported" ? gaps.length === 0 ? "high" : "medium" : status === "partial" ? verifiedModules > 0 ? "medium" : "low" : "low";
  const summary = status === "supported" || status === "partial"
    ? coverage.length
      ? claims.length + " source-backed " + (claims.length === 1 ? "claim aligns" : "claims align") + ". Module coverage: " + verifiedModules + " of " + moduleCoverage.length + " verified."
      : claims.length + " source-backed " + (claims.length === 1 ? "claim aligns" : "claims align") + " with the current planning basis."
    : status === "conflict"
      ? conflicts.length + " claim " + (conflicts.length === 1 ? "needs" : "claims need") + " review before treating this plan as settled."
      : status === "insufficient"
        ? analysisFailed
          ? "Knowledge Base evidence was retrieved, but structured claim analysis could not be completed."
          : "The Knowledge Base was read, but it did not provide a source-backed claim for this question."
        : "This result uses the curated catalog because no live Knowledge Base evidence was available.";
  const basis = status === "conflict"
    ? "The catalog remains the calculation basis. Conflicting evidence is shown separately and never overwrites a number automatically."
    : status === "supported" || status === "partial"
      ? analysisFailed
        ? completeCoverage
          ? "The deterministic catalog calculation remains authoritative. Structured Knowledge Base claims align for every listed target; optional AI synthesis did not complete."
          : "The deterministic catalog calculation remains authoritative. Structured Knowledge Base claims support only the covered items shown below; optional AI synthesis did not complete."
        : completeCoverage
          ? "The deterministic catalog calculation remains authoritative and every listed case and module target has an aligned source-backed comparison."
          : "The deterministic catalog calculation remains authoritative. Evidence supports only the covered items shown below; missing modules are not treated as verified."
      : analysisFailed
        ? "The retrieved evidence remains available for inspection. The deterministic catalog calculation is the only decision basis until analysis succeeds."
        : "The deterministic catalog calculation is the only decision basis for this run.";

  return {
    decision: { status, confidence, blocking, summary, basis }, claims, gaps,
    coverage: {
      caseVerified: caseCoverage?.status === "aligned",
      verifiedModules,
      totalModules: moduleCoverage.length,
      targets: coverage,
    },
  };
}
