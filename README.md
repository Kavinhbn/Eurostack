# Rackwise

Rackwise is an evidence-led Eurorack compatibility agent built for the DEV Sanity Challenge, Path One. It combines Sanity Context retrieval with deterministic width, depth, and power checks. Conflicting specifications stay visible instead of being silently averaged away.

## Architecture

1. The browser sends the selected case, modules, headroom, and question to `/api/plan`.
2. The server calculates all measurable constraints in plain TypeScript.
3. A tiny MCP client reads the Sanity Knowledge Base outline and retrieves the most relevant entries.
4. An optional OpenAI-compatible model proposes a structured set of source claims rather than free-form facts.
5. The server validates every proposed URL and Knowledge Base path, compares normalized values against the catalog, and produces a supported, conflicting, insufficient, or catalog-only decision.
6. The request is traced to a self-hosted Langfuse instance when credentials are configured.

No LangChain or LangGraph dependency is used.

## Backend API

- `POST /api/plan` validates a row, applies a per-client request limit, performs deterministic calculations, optionally retrieves live Sanity evidence, and optionally asks the configured model for an explanation.
- `GET /api/status?probe=1` performs bounded, read-only checks against Sanity Context, the model endpoint, and the self-hosted Langfuse readiness endpoint. It never returns credentials or configured URLs.
- `GET /api/catalog` exposes the versioned module and case snapshot with an ETag and cache headers.

Every response carries an `X-Request-Id`; completed planning calls also expose `Server-Timing`. External failures degrade to the local catalog rather than discarding the deterministic result. The Knowledge Base outline is cached briefly, while evidence is retrieved live for each plan.

## Local setup

Copy `.env.example` to `.env.local` and provide:

- a Sanity Context MCP endpoint;
- an organization token with Context Viewer permission;
- the Knowledge Base public ID;
- an OpenAI-compatible model endpoint, such as Ollama;
- local Langfuse URL and project keys.

Then run:

```bash
npm install
npm run dev
```

Without credentials, Rackwise uses its curated catalog. It never fabricates a Knowledge Base response or tracing timings. A model failure or unavailable Sanity endpoint leaves numerical checks available and is shown in the Trace view.

## Current scope

- One 104 HP row with a TPS80W supply profile. The 53 mm depth limit is an explicit planning assumption, not a verified case measurement; other rows are assumed empty.
- Readable, responsive module cards with manufacturer links, local-device draft persistence, multiple instances of a module, and adjustable power reserve.
- The client and server share the same catalog and calculator. Changing the row, reserve or question marks the previous result as outdated.
- Sanity evidence is displayed as claim comparisons grouped by subject and property. Unsupported model citations are discarded, disagreements are marked as conflicts, and power or fit conflicts block the recommendation. Evidence never automatically overwrites curated numerical specifications.
- Langfuse requires an explicit self-hosted URL. Queued telemetry is not presented as confirmed delivery.

Run the dependency-free unit tests with Node 22.13+:

```bash
node --experimental-strip-types --test tests/planner.test.ts
```

This is a local development app, not yet a public multi-user service. The API includes basic same-origin checks and an in-memory request limit, but authentication, durable distributed limiting, and a production deployment review are still required before exposing the model-backed API publicly.

## Knowledge Base purpose

> Help Eurorack users determine whether combinations of cases, modules, power supplies, and 1U formats are physically and electrically compatible. Prefer current manufacturer documentation while preserving conflicting claims from other sources.

Recommended source groups:

- official case manuals and product pages;
- official module manuals and product pages;
- official Eurorack and 1U format documentation;
- narrowly scoped source files derived from official documentation when a manufacturer page is too large for the indexing limit.

Use the [Phase 1 Knowledge Base checklist](docs/phase-1-knowledge-base.md) to curate a small, demo-ready source set without exceeding the organization indexing limit.

## Environment compatibility

The current Langfuse packages require a self-hosted Langfuse server version compatible with the OpenTelemetry-based JavaScript SDK. If the app is deployed away from the machine running Langfuse, `LANGFUSE_BASE_URL` must be a private network address reachable from the app server; `localhost` only works when both run on the same machine.
