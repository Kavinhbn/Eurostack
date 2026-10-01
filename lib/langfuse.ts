import { connectionStatus } from "./configuration.ts";

let ready: Promise<void> | null = null;
async function ensureTracing() {
  if (!connectionStatus().langfuse) return false;
  if (!ready) ready = (async () => {
    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([import("@opentelemetry/sdk-node"), import("@langfuse/otel")]);
    const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor({
      baseUrl: process.env.LANGFUSE_BASE_URL!,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
      secretKey: process.env.LANGFUSE_SECRET_KEY!,
      timeout: 2, flushAt: 1, mediaUploadEnabled: false,
    })] });
    sdk.start();
  })();
  try { await ready; return true; } catch { ready = null; return false; }
}

// Observability must never prevent a numerical check or execute it twice.
export async function traced<T>(name: string, input: unknown, work: () => Promise<T>): Promise<{ output: T; queued: boolean }> {
  if (!(await ensureTracing())) return { output: await work(), queued: false };
  let observe: typeof import("@langfuse/tracing").startActiveObservation;
  try { observe = (await import("@langfuse/tracing")).startActiveObservation; }
  catch { return { output: await work(), queued: false }; }
  let completed = false;
  let completedOutput: T | undefined;
  try {
    return await observe(name, async (span) => {
      try { span.update({ input }); } catch { /* Best-effort instrumentation. */ }
      const output = await work();
      completedOutput = output;
      completed = true;
      try { span.update({ output }); } catch { /* Preserve the completed check. */ }
      return { output, queued: true };
    });
  } catch (error) {
    // If exporting the completed span failed, preserve the application result.
    if (completed) return { output: completedOutput as T, queued: false };
    throw error;
  }
}

export async function observed<T>(name: string, input: unknown, work: () => Promise<T>): Promise<T> {
  if (!(await ensureTracing())) return work();
  let observe: typeof import("@langfuse/tracing").startActiveObservation;
  try { observe = (await import("@langfuse/tracing")).startActiveObservation; }
  catch { return work(); }
  let completed = false;
  let completedOutput: T | undefined;
  try {
    return await observe(name, async (span) => {
      try { span.update({ input }); } catch { /* Best-effort instrumentation. */ }
      const output = await work();
      completedOutput = output;
      completed = true;
      try { span.update({ output }); } catch { /* Preserve the completed step. */ }
      return output;
    });
  } catch (error) {
    if (completed) return completedOutput as T;
    throw error;
  }
}
