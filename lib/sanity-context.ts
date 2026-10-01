type Envelope = {
  id?: string | number; error?: { message?: string };
  result?: { isError?: boolean; protocolVersion?: string; content?: Array<{ type: string; text?: string }> };
};

type InitialContextCache = { endpoint: string; value: string; expiresAt: number };
let initialContextCache: InitialContextCache | null = null;

function initialContextTtl() {
  const configured = Number(process.env.SANITY_INITIAL_CONTEXT_TTL_MS || 300000);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 10000), 3600000) : 300000;
}

async function fetchInitialContext(endpoint: string, token: string) {
  const now = Date.now();
  if (initialContextCache?.endpoint === endpoint && initialContextCache.expiresAt > now) return initialContextCache.value;
  const response = await fetch(endpoint.replace(/\/$/, "") + "/initial-context", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(6000), redirect: "manual", cache: "no-store",
  });
  if (!response.ok) throw new Error("Sanity Context returned HTTP " + response.status + " while reading the Knowledge Base outline.");
  const value = await response.text();
  if (!value.trim()) throw new Error("Sanity Context returned an empty Knowledge Base outline.");
  initialContextCache = { endpoint, value, expiresAt: now + initialContextTtl() };
  return value;
}

export function parseRpcResponse(raw: string, id: string): Envelope {
  const messages = raw.trim().startsWith("{")
    ? [JSON.parse(raw)]
    : raw.replace(/\r\n/g, "\n").split("\n\n").flatMap((event) => {
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return [];
        try { return [JSON.parse(data)]; } catch { return []; }
      });
  const message = messages.find((item: Envelope) => item.id === id);
  if (!message) throw new Error("Sanity returned no matching response.");
  if (message.error || message.result?.isError) throw new Error("Sanity could not complete this read. Check the endpoint permissions and Knowledge Base paths.");
  return message;
}

function textOf(envelope: Envelope) {
  return envelope.result?.content?.filter((item) => item.type === "text").map((item) => item.text || "").join("\n") || "";
}

export function selectKnowledgePaths(initial: string, moduleNames: string[], question: string, kbId: string, configured = "") {
  const sections = initial.split(/(?=Knowledge base id:)/i);
  const scoped = sections.find((section) => section.match(/^Knowledge base id:\s*\x60?(kb[\w-]+)/i)?.[1] === kbId) || initial;
  const outline = [...scoped.matchAll(/^(?:[-*]\s+)?\x60?([a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_-]+)*)\x60?(?:\s+\[(?:core|peripheral)\])?\s*$/gm)].map((match) => match[1]);
  const configuredPaths = configured.split(",").map((path) => path.trim()).filter(Boolean);
  const stopWords = new Set(["and", "the", "this", "that", "with", "from", "check"]);
  const words = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !stopWords.has(term));
  const moduleRoutes: Array<[RegExp, RegExp]> = [
    [/\bmaths\b/i, /envelope|modulator|maths/i],
    [/\bpamela/i, /sequencer|controller|clock|pamela/i],
    [/\bmorphagene\b/i, /granular|tape|morphagene/i],
    [/\bplaits\b/i, /plaits\/overview$|plaits$/i],
    [/\bdisting\s+ex\b/i, /module_compatibility$|disting[_/-]?ex|physical|fitment/i],
  ];
  const bestModulePaths = moduleNames.flatMap((name) => {
    const routed = moduleRoutes.find(([namePattern]) => namePattern.test(name));
    const semanticPath = routed && outline.find((path) => routed[1].test(path));
    if (semanticPath) return [semanticPath];
    const terms = words(name);
    const ranked = outline.map((path) => ({
      path,
      score: terms.reduce((score, term) => score + (path.toLowerCase().includes(term) ? term.length : 0), 0),
    })).sort((left, right) => right.score - left.score);
    return ranked[0]?.score > 0 ? [ranked[0].path] : [];
  });
  const generalTerms = words(question + " case power depth clearance");
  const generalPaths = outline.map((path) => ({
    path,
    score: generalTerms.reduce((score, term) => score + Number(path.toLowerCase().includes(term)), 0),
  })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score).map((item) => item.path);
  const coreCompatibilityPaths = outline.filter((path) => /(?:^|\/)(?:module_compatibility|cases_and_power|physical_fitment|power_and_wiring)$/i.test(path));
  return [...new Set([...configuredPaths, ...bestModulePaths, ...coreCompatibilityPaths, ...generalPaths])].slice(0, 12);
}

export async function retrieveRackEvidence(moduleNames: string[], question: string) {
  const endpoint = process.env.SANITY_CONTEXT_MCP_URL;
  const token = process.env.SANITY_ORGANIZATION_TOKEN;
  if (!endpoint || !token) throw new Error("Sanity Context is not configured.");
  let session: string | null = null;
  let protocol = "2025-03-26";
  async function rpc(method: string, params: unknown, notification = false) {
    const id = crypto.randomUUID();
    const response = await fetch(endpoint!, {
      method: "POST", signal: AbortSignal.timeout(15000), redirect: "manual",
      headers: { Authorization: "Bearer " + token, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": protocol, ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    if (!response.ok) throw new Error("Sanity Context returned HTTP " + response.status + ". Check the endpoint and organization token.");
    session = response.headers.get("Mcp-Session-Id") || session;
    if (notification) { await response.body?.cancel(); return {} as Envelope; }
    // Stop on the matching result: some servers keep SSE streams open afterwards.
    if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          raw += decoder.decode(value, { stream: !done });
          if (raw.length > 1_000_000) throw new Error("Sanity response is too large.");
          const events = raw.replace(/\r\n/g, "\n").split("\n\n");
          for (const event of events.slice(0, done ? undefined : -1)) {
            const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            let envelope: Envelope | null = null;
            try { envelope = JSON.parse(data); } catch { /* Heartbeat or partial event. */ }
            if (envelope?.id === id) return parseRpcResponse(JSON.stringify(envelope), id);
          }
          if (done) return parseRpcResponse(raw, id);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    return parseRpcResponse(await response.text(), id);
  }
  const init = await rpc("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "rackwise", version: "0.2.0" } });
  protocol = init.result?.protocolVersion || protocol;
  await rpc("notifications/initialized", {}, true);
  try {
    // Sanity exposes this read-only shortcut specifically so custom agents can
    // avoid spending an MCP roundtrip on every question. Cache only the outline;
    // evidence itself is always fetched live through knowledge_base_read.
    const initial = await fetchInitialContext(endpoint, token);
    const ids = [...initial.matchAll(/Knowledge base id:\s*\x60?(kb[\w-]+)/gi)].map((match) => match[1]);
    const kbId = process.env.SANITY_KNOWLEDGE_BASE_ID || (ids.length === 1 ? ids[0] : undefined);
    if (!kbId) throw new Error("Set SANITY_KNOWLEDGE_BASE_ID to choose the Knowledge Base.");
    const paths = selectKnowledgePaths(initial, moduleNames, question, kbId, process.env.SANITY_KB_PATHS);
    if (!paths.length) throw new Error("No matching entries found. Set SANITY_KB_PATHS from the Knowledge Base outline.");
    const evidence = textOf(await rpc("tools/call", { name: "knowledge_base_read", arguments: { knowledgeBase: kbId, paths } }));
    if (!evidence.trim()) throw new Error("Sanity returned empty evidence.");
    return { kbId, paths, evidence: evidence.slice(0, 60000) };
  } finally {
    if (session) await fetch(endpoint, { method: "DELETE", signal: AbortSignal.timeout(1000), redirect: "manual", headers: { Authorization: "Bearer " + token, "Mcp-Session-Id": session, "MCP-Protocol-Version": protocol } }).catch(() => {});
  }
}
