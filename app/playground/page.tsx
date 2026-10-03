"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface,
  DialogTitle, Field, FluentProvider, SearchBox, Select, Tab, TabList, Textarea,
  SSRProvider, webDarkTheme, type Theme,
} from "@fluentui/react-components";
import {
  Add24Regular, ArrowRight20Regular, ArrowUpRight20Regular, CheckmarkCircle20Regular,
  BotSparkle24Regular, Delete20Regular, Dismiss20Regular, Info20Regular, Library24Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import { CATALOG, CATALOG_VERSION, CASE, DEFAULT_MODULE_IDS, calculatePlan, type RackModule } from "@/lib/catalog";
import type { ConnectionReport, Connections, EvidenceClaim, PlanResult } from "@/lib/contracts";
import { SiteHeader } from "../components/SiteHeader";

const theme: Theme = {
  ...webDarkTheme,
  fontFamilyBase: 'var(--font-geist-sans), "Segoe UI", system-ui, sans-serif',
  fontSizeBase300: "16px", lineHeightBase300: "24px",
  borderRadiusMedium: "8px", borderRadiusLarge: "12px",
  colorBrandBackground: "#cf5326", colorBrandBackgroundHover: "#b94720",
  colorBrandBackgroundPressed: "#9d3c1a",
  colorBrandForeground1: "#f2a07a", colorBrandForeground2: "#f2a07a",
  colorCompoundBrandForeground1: "#f2a07a", colorCompoundBrandForeground1Hover: "#ffd0bb",
  colorCompoundBrandStroke: "#dc7145", colorCompoundBrandStrokeHover: "#f2a07a",
  colorNeutralBackground1: "#1b1d20", colorNeutralBackground2: "#232528",
  colorNeutralBackground3: "#272a2d", colorNeutralForeground1: "#f3f1ed",
  colorNeutralForeground2: "#bfbdb7", colorNeutralForeground3: "#aaa8a2",
};
type View = "planner" | "evidence" | "trace";
type ConversationTurn = { question: string; result: PlanResult };
const DEFAULT_QUESTION = "Does this row have enough space and power?";
const THINKING_STAGES = ["Checking rack limits", "Reading Sanity entries", "Comparing module variants", "Preparing a grounded answer"];
const propertyLabels = { width: "Width", depth: "Depth", plus12: "+12V draw", minus12: "-12V draw", plus5: "+5V draw", compatibility: "Compatibility", other: "Other claim" } as const;

export default function PlaygroundPage() {
  const [moduleIds, setModuleIds] = useState<string[]>(DEFAULT_MODULE_IDS);
  const [headroom, setHeadroom] = useState(0.2);
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [view, setView] = useState<View>("planner");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [connectionChecks, setConnectionChecks] = useState<ConnectionReport | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [thinkingStage, setThinkingStage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removedModule, setRemovedModule] = useState<{ module: RackModule; index: number } | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStored, setDraftStored] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const plan = useMemo(() => calculatePlan(moduleIds, headroom), [moduleIds, headroom]);
  const selectedModule = detailIndex === null ? null : plan.modules[detailIndex];
  const filtered = CATALOG.filter((item) => (item.name + " " + item.maker + " " + item.family).toLowerCase().includes(query.toLowerCase()));
  const stale = result !== null && (JSON.stringify(result.input.moduleIds) !== JSON.stringify(moduleIds) || result.input.headroom !== headroom);
  const available = CASE.hp - plan.totals.hp;
  const sanityState = connectionChecks?.sanity?.state;
  const sanityLabel = connectionError ? "Status unavailable" : sanityState === "ready" ? "Sanity connected" : sanityState === "unreachable" ? "Sanity unavailable" : sanityState === "configured" ? "Sanity configured" : connections ? connections.sanity ? "Sanity configured" : "Sanity not configured" : "Checking Sanity";
  const claimGroups = useMemo(() => {
    const groups = new Map<string, EvidenceClaim[]>();
    for (const claim of result?.assessment.claims || []) {
      const key = claim.subject + "::" + claim.property;
      groups.set(key, [...(groups.get(key) || []), claim]);
    }
    return [...groups.values()];
  }, [result]);

  async function refreshConnections() {
    setConnectionError(false);
    setConnectionChecks(null);
    try {
      const response = await fetch("/api/status?probe=1", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { connections: Connections; checks: ConnectionReport | null };
      setConnections(payload.connections);
      setConnectionChecks(payload.checks);
    } catch { setConnectionError(true); }
  }

  useEffect(() => {
    const connectionTimer = window.setTimeout(() => void refreshConnections(), 0);
    const draftTimer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem("rackwise-row-v2") || "null");
        if (saved && Array.isArray(saved.moduleIds) && typeof saved.headroom === "number") {
          calculatePlan(saved.moduleIds, saved.headroom);
          setModuleIds(saved.moduleIds);
          setHeadroom(saved.headroom);
        }
      } catch { /* An invalid or unavailable local draft must not block the planner. */ }
      setDraftReady(true);
    }, 0);
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setLibraryOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => { window.clearTimeout(connectionTimer); window.clearTimeout(draftTimer); window.removeEventListener("keydown", shortcut); requestRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    const storageTimer = window.setTimeout(() => {
      try { localStorage.setItem("rackwise-row-v2", JSON.stringify({ moduleIds, headroom })); setDraftStored(true); }
      catch { setDraftStored(false); }
    }, 0);
    return () => window.clearTimeout(storageTimer);
  }, [moduleIds, headroom, draftReady]);

  useEffect(() => {
    if (!loading) return;
    const interval = window.setInterval(() => setThinkingStage((current) => (current + 1) % THINKING_STAGES.length), 1250);
    return () => window.clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    if (!removedModule) return;
    const timer = window.setTimeout(() => setRemovedModule(null), 10000);
    return () => window.clearTimeout(timer);
  }, [removedModule]);

  useEffect(() => {
    if (!conversation.length && !loading) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    conversationEndRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
  }, [conversation.length, loading]);

  function add(module: RackModule) {
    if (moduleIds.length >= 32) return;
    setModuleIds((current) => [...current, module.id]);
    setRemovedModule(null);
    setNotice(module.name + " added to Row A.");
    setError("");
  }

  function remove(index: number) {
    const removedItem = plan.modules[index];
    if (!removedItem) return;
    setNotice(removedItem.name + " removed from Row A.");
    setModuleIds((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setRemovedModule({ module: removedItem, index });
    setDetailIndex(null);
    setError("");
  }

  function undoRemove() {
    if (!removedModule) return;
    const { module: removedItem, index } = removedModule;
    setModuleIds((current) => {
      const restored = [...current];
      restored.splice(Math.min(index, restored.length), 0, removedItem.id);
      return restored;
    });
    setNotice(removedItem.name + " restored to Row A.");
    setRemovedModule(null);
  }

  function resetRack() {
    requestRef.current?.abort();
    setModuleIds(DEFAULT_MODULE_IDS);
    setHeadroom(0.2);
    setQuestion(DEFAULT_QUESTION);
    setResult(null);
    setConversation([]);
    setView("planner");
    setLoading(false);
    setError("");
    setRemovedModule(null);
    setNotice("The example rack has been restored.");
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (loading || !moduleIds.length || !question.trim()) return;
    const askedQuestion = question.trim();
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 70000);
    setThinkingStage(0); setPendingQuestion(askedQuestion); setLoading(true); setError("");
    try {
      const response = await fetch("/api/plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: askedQuestion, moduleIds, headroom }), signal: controller.signal,
      });
      const payload = await response.json() as PlanResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "The check could not be completed.");
      setResult(payload);
      setConversation((current) => [...current, { question: askedQuestion, result: payload }].slice(-8));
      setQuestion("");
      setNotice("Compatibility check complete.");
    } catch (caught) {
      setError(controller.signal.aborted ? "The check took too long. Please try again." : caught instanceof Error ? caught.message : "The check could not be completed.");
    } finally { clearTimeout(timer); setLoading(false); setThinkingStage(0); setPendingQuestion(""); }
  }

  return <SSRProvider><FluentProvider theme={theme} className="fluent-root">
    <a className="skip-link" href="#workspace">Skip to planner</a>
    <SiteHeader />

    <main id="workspace" className="workspace">
      <section className="playground-command" aria-labelledby="playground-title">
        <div className="playground-command-copy">
          <p className="playground-kicker">No account required</p>
          <h1 id="playground-title">Plan a rack with evidence.</h1>
          <p>Check fit, power and specifications against real manufacturer sources before you buy.</p>
        </div>
        <div className="workspace-signals">
          <button className={"connection-signal " + (sanityState === "ready" ? "is-ready" : "is-muted")} type="button" onClick={() => setConnectionsOpen(true)}>
            <span aria-hidden="true" />
            <span><strong>{sanityLabel}</strong><small>View service status</small></span>
          </button>
          <dl aria-label="Workspace capabilities">
            <div><dt>Calculation</dt><dd>Deterministic</dd></div>
            <div><dt>Rack draft</dt><dd>This browser</dd></div>
          </dl>
        </div>
      </section>
      <div className="view-bar">
        <TabList selectedValue={view} onTabSelect={(_, data) => setView(data.value as View)} aria-label="Workspace views" size="large">
          <Tab id="planner-tab" value="planner">Planner</Tab>
          <Tab id="evidence-tab" value="evidence" disabled={!result}>Evidence {result ? `(${result.assessment.claims.length})` : ""}</Tab>
          <Tab id="trace-tab" value="trace" disabled={!result}>Trace</Tab>
        </TabList>
        <div className="workspace-actions"><span className="catalog-label">{result ? result.mode === "sanity" && !stale ? "Live evidence retrieved" : "Catalog-only result" : "Ready to check"}</span><Button appearance="subtle" size="small" onClick={resetRack}>Reset <span className="reset-detail">example</span></Button></div>
      </div>
      <div className="live-notice" role="status">{notice}</div>
      {removedModule && <div className="undo-notice" role="status">
        <span><strong>{removedModule.module.name}</strong> removed</span>
        <Button appearance="subtle" size="small" onClick={undoRemove}>Undo</Button>
        <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label="Dismiss removal message" onClick={() => setRemovedModule(null)} />
      </div>}

      {view === "planner" && <div className="planner-layout" role="tabpanel" aria-labelledby="planner-tab">
        <div className="rack-column">
          <section className="rack-panel" aria-labelledby="row-title">
            <div className="panel-heading">
              <div className="row-title"><span className="row-symbol" aria-hidden="true"><Library24Regular /></span><div><h2 id="row-title">Row A</h2><p>3U Eurorack <span>/</span> {CASE.hp} HP</p></div></div>
              <Button appearance="secondary" icon={libraryOpen ? <Dismiss20Regular /> : <Add24Regular />} onClick={() => setLibraryOpen((current) => !current)} aria-expanded={libraryOpen} aria-controls="inline-module-library">{libraryOpen ? "Close library" : "Add module"}</Button>
            </div>

            {libraryOpen && <section id="inline-module-library" className="inline-module-library" aria-labelledby="module-library-title">
              <header className="inline-library-header">
                <div className="inline-library-title"><Library24Regular aria-hidden="true" /><div><h3 id="module-library-title">Browse modules</h3><p>Add modules without leaving your rack.</p></div></div>
                <SearchBox className="library-search" aria-label="Search modules" value={query} onChange={(_, data) => setQuery(data.value)} placeholder="Search name, maker or function" />
                <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label="Close module library" onClick={() => setLibraryOpen(false)} />
              </header>
              {filtered.length ? <div className="inline-library-track">
                {filtered.map((module) => {
                  const quantity = moduleIds.filter((id) => id === module.id).length;
                  return <article key={module.id} className="inline-library-module">
                    <div><span className="source-maker">{module.maker}</span><h3>{module.name}</h3></div>
                    <dl><div><dt>Width</dt><dd>{module.hp} HP</dd></div><div><dt>Depth</dt><dd>{module.depthMm} mm</dd></div><div><dt>+12V</dt><dd>{module.plus12Ma} mA</dd></div></dl>
                    <footer><span>{quantity ? quantity + " in row" : "Not selected"}</span><Button appearance="secondary" size="small" icon={<Add24Regular />} onClick={() => add(module)} disabled={moduleIds.length >= 32} aria-label={"Add " + module.name}>{quantity ? "Add another" : "Add"}</Button></footer>
                  </article>;
                })}
              </div> : <div className="search-empty"><h3>No matching modules</h3><p>Try another name, manufacturer or function.</p><Button appearance="subtle" onClick={() => setQuery("")}>Clear search</Button></div>}
              {moduleIds.length >= 32 && <p className="inline-library-limit" role="status">The 32-module planning limit has been reached.</p>}
            </section>}

            <div className="capacity-overview">
              <div className="capacity-label"><span><strong>{plan.totals.hp}</strong> of {CASE.hp} HP used</span><span className={available < 0 ? "text-danger" : "capacity-free"}>{available < 0 ? Math.abs(available) + " HP over capacity" : available + " HP available"}</span></div>
              <div className={"allocation-strip" + (available < 0 ? " over-capacity" : "")} role="img" aria-label={plan.modules.map((module, index) => "Slot " + (index + 1) + ": " + module.name + ", " + module.hp + " HP").join("; ") + ". " + available + " HP remaining."}>
                {plan.modules.map((module, index) => <span key={index} className="allocation-segment" style={{ flexGrow: module.hp }} title={module.name + " · " + module.hp + " HP"}>{module.hp / Math.max(CASE.hp, plan.totals.hp) >= 0.07 ? String(index + 1).padStart(2, "0") : ""}</span>)}
                {available > 0 && <span className="allocation-free" style={{ flexGrow: available }} />}
              </div>
              <div className="allocation-caption"><span>Space allocation</span><span>Rack below is proportional</span></div>
            </div>

            {plan.modules.length ? <div className="rack-rail-wrap">
              <div className="rack-rail" role="list" aria-label="Modules in Row A">
                {plan.modules.map((module, index) => <article key={module.id + "-" + index} role="listitem" style={{ "--module-hp": module.hp } as CSSProperties} className={"rack-module" + (detailIndex === index ? " is-selected" : "")}>
                  <div className="rack-module-label"><span>{String(index + 1).padStart(2, "0")}</span><small>{module.hp} HP</small></div>
                  <div><h3>{module.name}</h3><p>{module.maker}</p></div>
                  <dl><div><dt>Depth</dt><dd>{module.depthMm} mm</dd></div><div><dt>+12V</dt><dd>{module.plus12Ma} mA</dd></div></dl>
                  <div className="rack-module-actions"><Button appearance="subtle" size="small" type="button" onClick={() => setDetailIndex(index)} aria-label={"Specifications and source for " + module.name}>Specs</Button><Button className="rack-remove-button" appearance="subtle" size="small" type="button" icon={<Delete20Regular />} title={"Remove " + module.name} aria-label={"Remove " + module.name} onClick={() => remove(index)} /></div>
                </article>)}
                {available > 0 && <div className="rack-free-bay" style={{ "--module-hp": available } as CSSProperties}><span>{available} HP free</span></div>}
              </div>
              <p className="rack-rail-hint">Module widths are proportional. Select Specs to inspect power, depth and the manufacturer source.</p>
            </div> : <div className="empty-row"><Library24Regular /><h3>Your row is empty</h3><p>Add a module to start planning its space and power.</p><Button appearance="primary" onClick={() => setLibraryOpen(true)}>Browse modules</Button></div>}
            <div className="rack-footer"><span>{plan.modules.length} {plan.modules.length === 1 ? "module" : "modules"} in this row</span><span>{draftStored ? "Draft saved on this device" : "Draft in this tab only"}</span></div>
          </section>
          <details className="profile-note">
            <summary><Info20Regular /><span>Planning profile & assumptions</span><span className="profile-name">104 HP / TPS80W</span></summary>
            <p>{CASE.note}</p><a href={CASE.sourceUrl} target="_blank" rel="noreferrer">View power supply specifications <ArrowUpRight20Regular /></a>
          </details>
        </div>

        <aside className="analysis-column" aria-label="Rackwise agent">
          <section className="agent-shell">
            <header className="agent-header">
              <div className="agent-identity"><span className="ai-identity-icon" aria-hidden="true"><BotSparkle24Regular /></span><div><h2>Rackwise agent</h2><p>Answers from your rack, catalog and Sanity evidence</p></div></div>
              <Badge appearance="outline" color={plan.fits ? "success" : "warning"}>{moduleIds.length ? plan.fits ? "Rack within limits" : "Review rack" : "Empty rack"}</Badge>
            </header>

            <details className="agent-rack-context">
              <summary><span>Current rack calculation</span><strong>{plan.totals.hp} / {CASE.hp} HP</strong></summary>
              <dl className="check-list agent-checks">
                <Check label="Row width" value={plan.totals.hp + " / " + CASE.hp + " HP"} pass={plan.checks.width} />
                <Check label="Depth" value={plan.totals.depthMm + " / " + CASE.maxDepthMm + " mm"} pass={plan.checks.depth} />
                <Check label="+12V budget" value={plan.totals.plus12Ma + " / " + plan.limits.plus12Ma + " mA"} pass={plan.checks.plus12} />
                <Check label="-12V budget" value={plan.totals.minus12Ma + " / " + plan.limits.minus12Ma + " mA"} pass={plan.checks.minus12} />
                <Check label="+5V budget" value={plan.totals.plus5Ma + " / " + plan.limits.plus5Ma + " mA"} pass={plan.checks.plus5} />
              </dl>
            </details>

            <div className="conversation" aria-live="polite" aria-busy={loading}>
              {!conversation.length && !loading && <div className="assistant-message welcome-message">
                <div className="agent-avatar" aria-hidden="true"><BotSparkle24Regular /></div>
                <div className="message-body"><strong>Ask me about this rack.</strong><p>I check space, depth and power first, then compare the result with source-backed Sanity evidence.</p>
                  <div className="prompt-suggestions" aria-label="Suggested questions">
                    {["Does this rack have enough space and power?", "Which specifications are verified by sources?"].map((prompt) => <Button appearance="outline" size="small" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</Button>)}
                  </div>
                </div>
              </div>}

              {conversation.map((turn) => {
                const turnIsStale = JSON.stringify(turn.result.input.moduleIds) !== JSON.stringify(moduleIds) || turn.result.input.headroom !== headroom;
                return <div className="conversation-turn" key={turn.result.id}>
                <div className="user-message"><p>{turn.question}</p></div>
                <AgentReply result={turn.result} stale={turnIsStale} onEvidence={() => { setResult(turn.result); setView("evidence"); }} onTrace={() => { setResult(turn.result); setView("trace"); }} />
              </div>})}

              {loading && <div className="conversation-turn pending-turn">
                <div className="user-message"><p>{pendingQuestion}</p></div>
                <div className="assistant-message thinking-message" role="status">
                  <div className="thinking-spinner" aria-hidden="true"><span /><span /><span /></div>
                  <div className="message-body"><strong>Working through the evidence</strong><p key={thinkingStage}>{THINKING_STAGES[thinkingStage]}</p><ol className="thinking-progress" aria-label="Check progress">{THINKING_STAGES.map((stage, index) => <li className={index < thinkingStage ? "is-done" : index === thinkingStage ? "is-active" : ""} key={stage}>{stage}</li>)}</ol></div>
                </div>
              </div>}
              <div ref={conversationEndRef} className="conversation-end" aria-hidden="true" />
            </div>

            <form onSubmit={ask} className="agent-composer">
              <Textarea value={question} onChange={(_, data) => setQuestion(data.value)} rows={2} maxLength={2000} resize="vertical" aria-label="Ask Rackwise about this rack" placeholder="Ask about fit, power, evidence or a module..." />
              <div className="composer-actions">
                <Field label="Power reserve" orientation="horizontal">
                  <Select value={String(headroom)} onChange={(_, data) => setHeadroom(Number(data.value))} aria-label="Power reserve">
                    {[0, 0.1, 0.2, 0.3, 0.5].map((reserve) => <option key={reserve} value={reserve}>{Math.round(reserve * 100)}%</option>)}
                  </Select>
                </Field>
                <Button appearance="primary" type="submit" disabled={loading || !moduleIds.length || !question.trim()} icon={<ArrowRight20Regular />} iconPosition="after">{loading ? "Checking" : "Ask Rackwise"}</Button>
              </div>
              {error && <div className="feedback error-feedback" role="alert">{error}</div>}
            </form>
          </section>
        </aside>
      </div>}

      {view === "planner" && result && <section className={"decision-dock " + result.assessment.decision.status} aria-label="Latest evidence decision">
        <div className="decision-dock-copy"><span>Latest decision</span><strong>{result.assessment.decision.summary}</strong><p>{result.assessment.decision.basis}</p></div>
        <dl><div><dt>Fit</dt><dd>{result.calculation.fits ? "Pass" : "Review"}</dd></div><div><dt>Coverage</dt><dd>{result.assessment.coverage.verifiedModules}/{result.assessment.coverage.totalModules}</dd></div><div><dt>Claims</dt><dd>{result.assessment.claims.length}</dd></div><div><dt>Evidence</dt><dd>{decisionLabel(result.assessment.decision.status)}</dd></div></dl>
        <div><Button appearance="primary" onClick={() => setView("evidence")}>Review sources</Button><Button appearance="subtle" onClick={() => setView("trace")}>View trace</Button></div>
      </section>}

      {view === "evidence" && <section className="secondary-view" role="tabpanel" aria-labelledby="evidence-tab">
        <div className="secondary-heading"><h2>Evidence review</h2><p>Compare retrieved claims with the values used by the planner. Catalog snapshot: {CATALOG_VERSION}.</p></div>
        {result ? <section className={"evidence-decision " + result.assessment.decision.status} aria-labelledby="decision-heading">
          <div className="evidence-decision-heading"><div><span>Decision status</span><h3 id="decision-heading">{result.assessment.decision.summary}</h3></div><Badge appearance="filled" color={decisionColor(result.assessment.decision.status)}>{decisionLabel(result.assessment.decision.status)}</Badge></div>
          <div className="decision-facts"><div><span>Confidence</span><strong>{capitalize(result.assessment.decision.confidence)}</strong></div><div><span>Claims</span><strong>{result.assessment.claims.length}</strong></div><div><span>Modules verified</span><strong>{result.assessment.coverage.verifiedModules} / {result.assessment.coverage.totalModules}</strong></div><div><span>Blocking issue</span><strong>{result.assessment.decision.blocking ? "Yes" : "None"}</strong></div></div>
          <p>{result.assessment.decision.basis}</p>
          {stale && <p className="stale-notice">This decision belongs to a previous selection. Run a fresh check to update it.</p>}
        </section> : <div className="evidence-empty"><Info20Regular /><div><h3>No evidence decision yet</h3><p>Run a compatibility check to retrieve and compare source-backed claims.</p></div><Button appearance="secondary" onClick={() => setView("planner")}>Return to planner</Button></div>}

        {result && <section className="coverage-section" aria-labelledby="coverage-heading">
          <div className="claims-heading"><div><h2 id="coverage-heading">Evidence coverage</h2><p>Verified means the Knowledge Base matches width, depth and every non-zero powered rail used by this decision. It is not a general safety guarantee.</p></div><span>{result.assessment.coverage.verifiedModules} of {result.assessment.coverage.totalModules} modules</span></div>
          <div className="coverage-list">{result.assessment.coverage.targets.map((target) => <div className={"coverage-item " + target.status} key={target.key}>
            <div><span>{target.kind === "case" ? "Case profile" : "Module"}</span><strong>{target.subject}</strong>{target.note && <small>{target.note}</small>}</div>
            <Badge appearance="outline" color={target.status === "aligned" ? "success" : target.status === "conflict" || target.status === "variant_mismatch" ? "warning" : "subtle"}>{target.status === "aligned" ? "Verified" : target.status === "conflict" ? "Conflict" : target.status === "unverified" ? "Unverified" : target.status === "variant_mismatch" ? "Different variant" : "No claim"}</Badge>
          </div>)}</div>
        </section>}

        {claimGroups.length > 0 && <section className="claims-section" aria-labelledby="claims-heading">
          <div className="claims-heading"><div><h2 id="claims-heading">Claims compared</h2><p>Each value remains attached to the source or Knowledge Base path that supplied it.</p></div><span>{claimGroups.length} {claimGroups.length === 1 ? "comparison" : "comparisons"}</span></div>
          <div className="claim-groups">{claimGroups.map((claims) => {
            const conflicted = claims.some((claim) => claim.status === "conflicts");
            const groupKey = claims[0].subject + "::" + claims[0].property;
            return <article className={"claim-group" + (conflicted ? " has-conflict" : "")} key={groupKey}>
              <header><div><span>{propertyLabels[claims[0].property]}</span><h3>{claims[0].subject}</h3></div><Badge appearance="outline" color={conflicted ? "warning" : claims.every((claim) => claim.status === "agrees") ? "success" : "informative"}>{conflicted ? "Conflict" : claims.every((claim) => claim.status === "agrees") ? "Aligned" : "Unverified"}</Badge></header>
              <div className="claim-list">{claims.map((claim) => <div className="claim-row" key={claim.id}>
                <div className="claim-value"><strong>{claim.displayValue}</strong>{claim.catalogValue && <span>Catalog: {claim.catalogValue}</span>}</div>
                <div className="claim-copy"><p>{claim.statement}</p><span>{claim.sourceTitle}{claim.knowledgePath ? " / " + claim.knowledgePath : ""}</span></div>
                {claim.sourceUrl ? <a href={claim.sourceUrl} target="_blank" rel="noreferrer" aria-label={"Open source for " + claim.subject}><ArrowUpRight20Regular /></a> : <Info20Regular aria-label="Knowledge Base path only" />}
              </div>)}</div>
            </article>;
          })}</div>
        </section>}

        {result?.assessment.gaps.length ? <section className="coverage-gaps"><div><Info20Regular /><h2>Evidence still needed</h2></div><ul>{result.assessment.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></section> : null}

        <div className="section-divider"><h2>Catalog references</h2><p>Manufacturer pages used by the deterministic calculation.</p></div>
        <div className="source-grid">
          {[{ title: "Planning profile", maker: "Intellijel TPS80W", url: CASE.sourceUrl, note: CASE.note }, ...[...new Set(moduleIds)].map((id) => {
            const item = CATALOG.find((module) => module.id === id)!;
            return { title: item.name, maker: item.maker, url: item.sourceUrl, note: item.note || "Curated manufacturer specification." };
          })].map((source) => <article className="source-card" key={source.url}><span className="source-maker">{source.maker}</span><h3>{source.title}</h3><p>{source.note}</p><a href={source.url} target="_blank" rel="noreferrer">Open manufacturer source <ArrowUpRight20Regular /></a></article>)}
        </div>
        <div className="knowledge-panel"><div className="panel-heading"><h2>Sanity Knowledge Base</h2><Badge appearance="outline">{result?.evidence ? stale ? "Previous check" : "Retrieved" : "Not retrieved"}</Badge></div>
          {result?.evidence ? <><p>Paths read: {result.paths.join(", ")}</p><details className="raw-evidence"><summary>Inspect retrieved entry text</summary><pre className="evidence-content">{result.evidence}</pre></details></> : <p>No live Knowledge Base entries have been read. Connect Sanity Context, then run a compatibility check. Catalog links above are not live MCP results.</p>}
        </div>
      </section>}

      {view === "trace" && <section className="secondary-view" role="tabpanel" aria-labelledby="trace-tab">
        <div className="secondary-heading"><h2>Every step, accounted for.</h2><p>{result ? "Measured steps from your last compatibility check." : "Run a check to see real timings and connection outcomes."}</p></div>
        {result ? <div className="trace-panel">
          <div className="trace-summary"><span>{new Date(result.createdAt).toLocaleString()}</span><strong>{result.durationMs} ms total</strong></div>
          {stale && <p className="stale-notice">This trace belongs to a previous selection.</p>}
          <ol className="trace-list">{result.trace.map((step) => <li key={step.name}><span className={"trace-icon " + step.status}>{step.status === "success" ? <CheckmarkCircle20Regular /> : step.status === "error" ? <Warning20Regular /> : <Info20Regular />}</span><div><h3>{step.name}</h3><p>{step.detail}</p></div><span className="trace-timing">{step.status === "skipped" ? "Skipped" : step.name === "Local Langfuse" ? step.status === "success" ? "Queued" : "Unavailable" : step.durationMs + " ms"}</span></li>)}</ol>
        </div> : <div className="empty-trace"><Info20Regular /><h3>No check run yet</h3><p>Nothing simulated here. Your next run will appear in this view.</p><Button appearance="secondary" onClick={() => setView("planner")}>Return to planner</Button></div>}
      </section>}
    </main>

    <Dialog open={Boolean(selectedModule)} onOpenChange={(_, data) => { if (!data.open) setDetailIndex(null); }}>
      <DialogSurface className="app-dialog"><DialogBody>
        <DialogTitle>{selectedModule?.name}</DialogTitle>
        <DialogContent>{selectedModule && <><p className="dialog-description">{selectedModule.maker} · {selectedModule.family}</p><dl className="detail-specs">{[["Width", selectedModule.hp + " HP"], ["Depth", selectedModule.depthMm + " mm"], ["+12V", selectedModule.plus12Ma + " mA"], ["−12V", selectedModule.minus12Ma + " mA"], ["+5V", selectedModule.plus5Ma + " mA"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="detail-note">{selectedModule.note}</p><a href={selectedModule.sourceUrl} target="_blank" rel="noreferrer">Open manufacturer source <ArrowUpRight20Regular /></a></>}</DialogContent>
        <DialogActions><Button appearance="secondary" onClick={() => { if (detailIndex !== null) remove(detailIndex); }}>Remove from row</Button><Button appearance="primary" onClick={() => setDetailIndex(null)}>Done</Button></DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>

    <Dialog open={connectionsOpen} onOpenChange={(_, data) => setConnectionsOpen(data.open)}>
      <DialogSurface className="app-dialog"><DialogBody>
        <DialogTitle>Service status</DialogTitle>
        <DialogContent><p className="dialog-description">Live health checks for evidence retrieval, agent responses and request tracing.</p>
          {connectionError ? <div className="feedback error-feedback" role="alert">Service status could not be read. <Button appearance="subtle" onClick={() => void refreshConnections()}>Retry</Button></div> :
          <div className="connection-list">{([["sanity", "Sanity Context", "Source-backed Knowledge Base retrieval"], ["model", "Answer model", "Grounded response generation"], ["langfuse", "Langfuse", "Request tracing and evaluation"]] as const).map(([key, title, description]) => {
            const check = connectionChecks?.[key];
            const label = check ? check.state === "ready" ? "Ready" : check.state === "unreachable" ? "Unavailable" : check.state === "configured" ? "Configured" : "Not configured" : connections ? connections[key] ? "Configured" : "Not configured" : "Checking…";
            return <div key={key}><div><h3>{title}</h3><p>{description}{check?.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}</p></div><Badge appearance="outline" color={check?.state === "ready" ? "success" : "warning"}>{label}</Badge></div>;
          })}</div>}
        </DialogContent><DialogActions><Button appearance="secondary" onClick={() => setConnectionsOpen(false)}>Done</Button></DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>
  </FluentProvider></SSRProvider>;
}

function AgentReply({ result, stale, onEvidence, onTrace }: { result: PlanResult; stale: boolean; onEvidence: () => void; onTrace: () => void }) {
  const coverage = result.assessment.coverage;
  const mismatch = coverage.targets.find((target) => target.status === "variant_mismatch");
  return <div className={"assistant-message agent-reply" + (stale ? " stale" : "")}>
    <div className="agent-avatar" aria-hidden="true"><BotSparkle24Regular /></div>
    <div className="message-body">
      <div className="message-meta"><strong>Rackwise</strong><span>{stale ? "Previous rack · " : ""}{new Date(result.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
      {stale && <p className="stale-notice">This answer belongs to an earlier rack selection. The numbers below have not been applied to your current row.</p>}
      <p className="agent-answer">{result.explanation || result.answer}</p>
      <div className="answer-facts" aria-label="Evidence summary">
        <span><small>Coverage</small><strong>{coverage.verifiedModules}/{coverage.totalModules}</strong> modules</span>
        <span><small>Evidence</small><strong>{result.assessment.claims.length}</strong> claims</span>
        <span><small>Decision</small><Badge appearance="outline" color={decisionColor(result.assessment.decision.status)}>{decisionLabel(result.assessment.decision.status)}</Badge></span>
      </div>
      {mismatch && <div className="variant-note"><Warning20Regular /><div><strong>Source match needed for {mismatch.subject}</strong><p>Rackwise found evidence for a different model, so {mismatch.subject} is excluded until its matching manufacturer source is available.</p></div></div>}
      <details className="result-caveats"><summary>Assumptions and limits ({result.warnings.length})</summary><div className="result-caveat-list">{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></details>
      <div className="message-actions"><Button appearance="subtle" onClick={onEvidence}>View evidence</Button><Button appearance="subtle" onClick={onTrace}>View trace</Button></div>
    </div>
  </div>;
}

function Check({ label, value, pass }: { label: string; value: string; pass: boolean }) {
  return <div className={pass ? "check-item" : "check-item failed"}><dt>{pass ? <CheckmarkCircle20Regular aria-label="Within limit" /> : <Warning20Regular aria-label="Over limit" />}{label}</dt><dd>{value}</dd></div>;
}

function decisionLabel(status: PlanResult["assessment"]["decision"]["status"]) {
  return { supported: "Supported", partial: "Partially supported", conflict: "Conflict", insufficient: "Incomplete", catalog_only: "Catalog only" }[status];
}

function decisionColor(status: PlanResult["assessment"]["decision"]["status"]): "success" | "warning" | "informative" | "subtle" {
  return { supported: "success", partial: "informative", conflict: "warning", insufficient: "informative", catalog_only: "subtle" }[status] as "success" | "warning" | "informative" | "subtle";
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
