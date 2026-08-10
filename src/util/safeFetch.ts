import dns from 'node:dns/promises';
import { Agent, buildConnector, type Dispatcher } from 'undici';

/**
 * The framework's ONE guarded egress primitive.
 *
 * Before this existed the base shipped no fetcher at all, so every consumer
 * rolled its own: a deployment's docs-ingest, status poller and issue filer
 * each called bare `fetch()`, and the only hardened path — the knowledge
 * link-checker — kept its SSRF guard privately, unexported to the others. That
 * is the wrong shape for a security primitive. A second agent built on this
 * framework would have inherited zero fetch protection and re-derived all of
 * it, badly, in a file nobody reviews as security-critical.
 *
 * The threat model is NOT "the operator typed a bad URL". It is:
 *
 *  - **SSRF.** A URL that reaches a caller-supplied host is an internal-network
 *    probe unless every resolved address is checked. Even a returned boolean
 *    ("did it respond?") is an oracle for scanning a private range or a cloud
 *    metadata endpoint.
 *  - **DNS rebinding / TOCTOU.** Checking the hostname and then calling
 *    `fetch()` is NOT enough: `fetch()` performs its OWN resolution, so a
 *    low-TTL record can answer public for the check and private for the
 *    request moments later. The fix is to resolve once and connect to that
 *    exact IP — which is why this module owns a pinned undici connector rather
 *    than a Node `http(s).Agent` (global `fetch` IS undici and ignores the
 *    latter entirely).
 *  - **Redirects.** A vetted host can redirect to an unvetted one, so every
 *    hop is re-checked and re-pinned independently. A guard applied only to
 *    the initial URL is decorative.
 *  - **Resource exhaustion.** An endless or enormous body hangs the turn that
 *    requested it, so the cap is enforced while STREAMING, not after
 *    buffering. `Content-Length` is a hint, never the enforcement — it can
 *    lie or be absent.
 *
 * Everything here fails CLOSED: an unparseable URL, a DNS error, an
 * unsupported scheme, a host outside the caller's allowlist, or any check that
 * throws all produce a refusal, never a request.
 *
 * **Policy is the caller's, enforcement is this module's.** `safeFetch` never
 * decides which hosts are reasonable — a framework cannot know that. The
 * caller supplies a {@link FetchPolicy}; this module makes it real.
 */

/** Injectable resolver so tests never touch the network. */
export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(hostname, { all: true });
}

/**
 * IPv4 ranges no caller-supplied URL may reach. Deliberately broader than
 * "private": anything that is a probe oracle or a metadata endpoint belongs
 * here, and the cost of over-blocking is a refused fetch rather than a leaked
 * internal service.
 */
const DISALLOWED_V4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network" / 0.0.0.0 -> localhost on many stacks
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  // CGNAT (RFC 6598). Tailscale/tailnet address space — a deployment that runs
  // an internal service over a tailnet would otherwise expose a blind
  // host/port probe oracle to anyone who can influence a fetched URL.
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking range
  ['169.254.0.0', 16], // includes 169.254.169.254, the usual cloud metadata address
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / "future use" (includes 255.255.255.255)
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isDisallowedIpv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return DISALLOWED_V4_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Split an IPv6 literal (`::`-compression-aware) into its 8 hex groups. */
function expandIpv6(ip: string): string[] {
  const addr = ip.split('%')[0]; // strip a zone id, if any
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, ''];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].map((p) => p || '0');
}

function isDisallowedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
  // The v4-in-v6 forms matter: `::ffff:169.254.169.254` reaches the same
  // metadata endpoint as the bare v4 literal, so both delegate to the v4 check
  // rather than being treated as ordinary (allowed) v6 addresses.
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isDisallowedIpv4(v4Mapped[1]);
  const v4Compat = normalized.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat) return isDisallowedIpv4(v4Compat[1]); // deprecated "IPv4-compatible" form
  const groups = expandIpv6(normalized).map((g) => parseInt(g, 16));
  const first16 = groups[0];
  if ((first16 & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((first16 & 0xffc0) === 0xfec0) return true; // fec0::/10 (deprecated site-local)
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return true; // 64:ff9b::/96 (NAT64 well-known prefix — may embed a disallowed IPv4 target)
  }
  return false;
}

/** True if `ip` falls in a loopback/private/link-local/cloud-metadata range. */
export function isDisallowedIp(ip: string, family: number): boolean {
  return family === 6 ? isDisallowedIpv6(ip) : isDisallowedIpv4(ip);
}

/**
 * Host allowlist match: an exact hostname, or a `.`-prefixed suffix meaning
 * "this domain and its subdomains" (`.example.com` matches `example.com` and
 * `a.example.com`). A bare suffix without the dot is NOT treated as a wildcard
 * — `example.com` matches only itself — so an entry can never accidentally
 * admit `notexample.com`.
 */
export function hostAllowed(hostname: string, allowHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, ''); // trailing dot is the same host
  return allowHosts.some((raw) => {
    const entry = raw.toLowerCase().replace(/\.$/, '');
    if (entry.startsWith('.')) {
      const bare = entry.slice(1);
      return host === bare || host.endsWith(entry);
    }
    return host === entry;
  });
}

export interface FetchPolicy {
  /**
   * Hostnames this fetch may reach, checked on the initial URL AND every
   * redirect hop. REQUIRED and must be non-empty: there is no "allow
   * everything" value, because a framework-level default of "any host" is
   * exactly the footgun this module exists to remove. A caller that genuinely
   * wants the open web has to say so by listing what it wants.
   */
  readonly allowHosts: readonly string[];
  /** Hard ceiling on the decoded body, enforced while streaming. */
  readonly maxBytes: number;
  /** Redirect hops followed before refusing. */
  readonly maxRedirects: number;
  /** Per-request timeout; the whole hop chain gets one budget each. */
  readonly timeoutMs: number;
  /**
   * Allowed response content types, matched as a prefix against the header's
   * mime type (`text/` admits `text/html; charset=utf-8`). Checked from the
   * HEADERS, before any body is read.
   */
  readonly contentTypes: readonly string[];
  /** Sent as `user-agent`; identify the bot honestly. */
  readonly userAgent: string;
}

export type BlockedReason =
  | 'bad-url'
  | 'scheme-not-https'
  | 'host-not-allowed'
  | 'private-address'
  | 'redirect-cap'
  | 'redirect-missing-location'
  | 'content-type'
  | 'too-large';

export type SafeFetchOutcome =
  /** The request completed and every check passed. `text` is capped-length. */
  | {
      kind: 'ok';
      status: number;
      contentType: string;
      finalUrl: string;
      bytes: number;
      text: string;
    }
  /** A policy check refused it. NO request was issued to the refused target. */
  | { kind: 'blocked'; reason: BlockedReason; detail?: string }
  /** The target was permitted but did not answer usably. */
  | { kind: 'unreachable'; reason: 'dns' | 'timeout' | 'network'; detail?: string }
  /** The target answered with a non-2xx status. */
  | { kind: 'http-error'; status: number; finalUrl: string };

type GuardOutcome =
  | { kind: 'allowed'; pinnedAddress: string }
  | { kind: 'blocked'; reason: BlockedReason }
  | { kind: 'dns-failure' };

/**
 * https-only, host-allowlisted, and DNS-checked — in that order. The allowlist
 * is checked BEFORE resolution deliberately: a disallowed host should not even
 * produce a DNS query, which would otherwise leak the attempted hostname to
 * the resolver (and to anyone watching it).
 *
 * On `'allowed'`, `pinnedAddress` is the ONE address the caller must connect
 * to. It is the single resolution for this hop; the request must never trigger
 * a second one.
 */
async function guardTarget(url: URL, policy: FetchPolicy, lookup: DnsLookupFn): Promise<GuardOutcome> {
  if (url.protocol !== 'https:') return { kind: 'blocked', reason: 'scheme-not-https' };
  if (!hostAllowed(url.hostname, policy.allowHosts)) {
    return { kind: 'blocked', reason: 'host-not-allowed' };
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(url.hostname);
  } catch {
    return { kind: 'dns-failure' };
  }
  if (addrs.length === 0) return { kind: 'dns-failure' };
  // EVERY resolved address must be permitted, not merely the one we pin: a
  // host answering with both a public and a private address must be refused
  // outright rather than silently pinned to whichever came first.
  if (addrs.some((a) => isDisallowedIp(a.address, a.family))) {
    return { kind: 'blocked', reason: 'private-address' };
  }
  return { kind: 'allowed', pinnedAddress: addrs[0].address };
}

export type DispatcherFactory = (pinnedAddress: string) => unknown;

/**
 * Connects by IP literal to `pinnedAddress` while leaving `host`/`servername`
 * untouched, so undici's default connector still presents the ORIGINAL
 * hostname as TLS SNI and the `Host` header stays correct. This is what
 * actually closes the rebinding gap: the socket never re-resolves, so there is
 * no second lookup for an attacker to win a race against.
 */
function pinnedConnect(pinnedAddress: string): buildConnector.connector {
  const connect = buildConnector({});
  return (opts, callback) => connect({ ...opts, hostname: pinnedAddress }, callback);
}

/** Real dispatcher factory (production default) — tests inject their own. */
export function buildPinnedDispatcher(pinnedAddress: string): Dispatcher {
  return new Agent({ connect: pinnedConnect(pinnedAddress) });
}

async function closeDispatcher(dispatcher: unknown): Promise<void> {
  const closeable = dispatcher as { close?: () => Promise<void> } | null;
  if (typeof closeable?.close === 'function') {
    try {
      await closeable.close();
    } catch {
      // best-effort cleanup — the request itself already completed
    }
  }
}

/**
 * Read at most `maxBytes` of the body, aborting the moment the cap is passed.
 *
 * Streaming rather than `res.text()` is the point: `text()` buffers the whole
 * response first, so a hostile or merely enormous body is already in memory by
 * the time any length check could run. `Content-Length` is checked first as a
 * cheap early exit, but it is a hint — absent on chunked responses and free to
 * lie — so the streaming cap is the real enforcement.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false }> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false };
  }
  if (!res.body) return { ok: true, text: '', bytes: 0 };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder('utf-8').decode(joined), bytes: total };
}

function contentTypeAllowed(header: string | null, allowed: readonly string[]): boolean {
  const mime = (header ?? '').split(';')[0].trim().toLowerCase();
  return allowed.some((a) => mime.startsWith(a.toLowerCase()));
}

export interface SafeFetchDeps {
  lookup?: DnsLookupFn;
  fetchImpl?: typeof fetch;
  buildDispatcher?: DispatcherFactory;
}

/**
 * Fetch `rawUrl` under `policy`, following redirects manually so every hop is
 * re-guarded and re-pinned.
 *
 * Redirects are followed with `redirect: 'manual'` precisely so the hop chain
 * stays under this module's control — handing `redirect: 'follow'` to fetch
 * would let the runtime chase a `Location` into a private address with no
 * check at all, which is the single easiest way to reintroduce SSRF after
 * having "added a guard".
 */
export async function safeFetch(
  rawUrl: string,
  policy: FetchPolicy,
  deps: SafeFetchDeps = {},
): Promise<SafeFetchOutcome> {
  const lookup = deps.lookup ?? defaultLookup;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const buildDispatcher = deps.buildDispatcher ?? buildPinnedDispatcher;

  if (policy.allowHosts.length === 0) {
    return { kind: 'blocked', reason: 'host-not-allowed', detail: 'empty allowlist' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'blocked', reason: 'bad-url' };
  }

  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    const guard = await guardTarget(url, policy, lookup);
    if (guard.kind === 'blocked') return { kind: 'blocked', reason: guard.reason, detail: url.hostname };
    if (guard.kind === 'dns-failure') return { kind: 'unreachable', reason: 'dns', detail: url.hostname };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), policy.timeoutMs);
    const dispatcher = buildDispatcher(guard.pinnedAddress);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': policy.userAgent, accept: policy.contentTypes.join(', ') },
        dispatcher: dispatcher as RequestInit['dispatcher'],
      });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      return { kind: 'unreachable', reason: aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
      await closeDispatcher(dispatcher);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return { kind: 'blocked', reason: 'redirect-missing-location' };
      try {
        url = new URL(location, url); // relative Location values are legal
      } catch {
        return { kind: 'blocked', reason: 'bad-url', detail: location };
      }
      continue; // re-guard and re-pin the new hop on the next iteration
    }

    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'http-error', status: res.status, finalUrl: url.toString() };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentTypeAllowed(contentType, policy.contentTypes)) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'blocked', reason: 'content-type', detail: contentType };
    }

    const body = await readCapped(res, policy.maxBytes);
    if (!body.ok) return { kind: 'blocked', reason: 'too-large' };

    return {
      kind: 'ok',
      status: res.status,
      contentType,
      finalUrl: url.toString(),
      bytes: body.bytes,
      text: body.text,
    };
  }

  return { kind: 'blocked', reason: 'redirect-cap' };
}
