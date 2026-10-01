type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function requestId() {
  return crypto.randomUUID();
}

export function responseHeaders(id: string, extra: Record<string, string> = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": id,
    ...extra,
  };
}

export function checkRateLimit(request: Request) {
  const configured = Number(process.env.RACKWISE_RATE_LIMIT_PER_MINUTE || 30);
  const limit = Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 5), 300) : 30;
  const key = request.headers.get("cf-connecting-ip") || "local";
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60000 });
    return { allowed: true, limit, remaining: limit - 1, retryAfter: 0 };
  }
  current.count += 1;
  const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  return { allowed: current.count <= limit, limit, remaining: Math.max(0, limit - current.count), retryAfter };
}
