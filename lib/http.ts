type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const activeDevices = new Set<string>();
const DEVICE_COOKIE = "rackwise_device";
let checksSinceCleanup = 0;

type LimitRule = { key: string; limit: number; windowMs: number };
type LimitResult = { allowed: boolean; limit: number; remaining: number; retryAfter: number; resetAfter: number };

export type RequestGuard = LimitResult & {
  deviceId: string;
  setCookie?: string;
};

function boundedEnv(name: string, fallback: number, min: number, max: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), min), max) : fallback;
}

function cookieValue(request: Request, name: string) {
  const match = request.headers.get("cookie")?.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match?.[1];
}

function clientIp(request: Request) {
  const forwarded = request.headers.get("x-vercel-forwarded-for")
    || request.headers.get("x-forwarded-for")
    || request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip");
  return forwarded?.split(",")[0]?.trim() || null;
}

function deviceIdentity(request: Request) {
  const existing = cookieValue(request, DEVICE_COOKIE);
  if (existing && /^[a-f0-9-]{20,64}$/i.test(existing)) return { id: existing };
  const id = crypto.randomUUID();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    id,
    setCookie: `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  };
}

function consume(rule: LimitRule, now: number): LimitResult {
  const current = buckets.get(rule.key);
  if (!current || current.resetAt <= now) {
    buckets.set(rule.key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, limit: rule.limit, remaining: rule.limit - 1, retryAfter: 0, resetAfter: Math.ceil(rule.windowMs / 1000) };
  }
  current.count += 1;
  const resetAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  return {
    allowed: current.count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - current.count),
    retryAfter: current.count <= rule.limit ? 0 : resetAfter,
    resetAfter,
  };
}

function pruneExpired(now: number) {
  checksSinceCleanup += 1;
  if (checksSinceCleanup < 100 && buckets.size < 2000) return;
  checksSinceCleanup = 0;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

export function requestId() { return crypto.randomUUID(); }

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

export function checkRateLimit(request: Request): RequestGuard {
  const now = Date.now();
  pruneExpired(now);
  const device = deviceIdentity(request);
  const ip = clientIp(request);
  const windowSeconds = boundedEnv("RACKWISE_RATE_WINDOW_SECONDS", 600, 60, 3600);
  const deviceLimit = boundedEnv("RACKWISE_DEVICE_RATE_LIMIT", 8, 2, 100);
  const deviceDailyLimit = boundedEnv("RACKWISE_DEVICE_DAILY_LIMIT", 30, deviceLimit, 500);
  const ipLimit = boundedEnv("RACKWISE_IP_RATE_LIMIT", 24, deviceLimit, 500);
  const ipDailyLimit = boundedEnv("RACKWISE_IP_DAILY_LIMIT", 120, ipLimit, 2000);
  const rules: LimitRule[] = [
    { key: `device:${device.id}:window`, limit: deviceLimit, windowMs: windowSeconds * 1000 },
    { key: `device:${device.id}:day`, limit: deviceDailyLimit, windowMs: 86_400_000 },
  ];
  if (ip) rules.push(
    { key: `ip:${ip}:window`, limit: ipLimit, windowMs: windowSeconds * 1000 },
    { key: `ip:${ip}:day`, limit: ipDailyLimit, windowMs: 86_400_000 },
  );

  const results = rules.map((rule) => consume(rule, now));
  const denied = results.filter((result) => !result.allowed).sort((a, b) => b.retryAfter - a.retryAfter)[0];
  const primary = results[0];
  return {
    ...(denied || primary),
    allowed: !denied,
    remaining: Math.min(...results.map((result) => result.remaining)),
    deviceId: device.id,
    setCookie: device.setCookie,
  };
}

export function beginDeviceRequest(deviceId: string) {
  if (activeDevices.has(deviceId)) return false;
  activeDevices.add(deviceId);
  return true;
}

export function endDeviceRequest(deviceId: string) {
  activeDevices.delete(deviceId);
}
