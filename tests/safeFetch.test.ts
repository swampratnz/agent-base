import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  safeFetch,
  isDisallowedIp,
  hostAllowed,
  type FetchPolicy,
  type DnsLookupFn,
} from '../src/util/safeFetch.js';

// safeFetch is the framework's only guarded egress primitive, so most of these
// are SECURITY: cases — the module's whole value is what it REFUSES. Every test
// injects `lookup`, `fetchImpl` and `buildDispatcher`, so nothing here touches
// DNS or the network.

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

const POLICY: FetchPolicy = {
  allowHosts: ['example.com', '.docs.example.org'],
  maxBytes: 1024,
  maxRedirects: 3,
  timeoutMs: 1000,
  contentTypes: ['text/'],
  userAgent: 'test-agent',
};

function lookupTo(map: Record<string, Array<{ address: string; family: number }>>): DnsLookupFn {
  return async (hostname) => {
    const hit = map[hostname];
    if (!hit) throw new Error(`no record for ${hostname}`);
    return hit;
  };
}

/** A fetch stub returning scripted responses, recording the URLs it was asked for. */
function fetchStub(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  const calls: string[] = [];
  let i = 0;
  const impl = (async (input: string | URL) => {
    calls.push(String(input));
    const spec = responses[Math.min(i++, responses.length - 1)];
    return new Response(spec.body ?? '', { status: spec.status, headers: spec.headers ?? {} });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noopDispatcher = () => ({ close: async () => {} });

// --- address classification -------------------------------------------------

test('SECURITY: isDisallowedIp rejects loopback, private, CGNAT, link-local and cloud-metadata ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1', // CGNAT / tailnet
    '169.254.169.254', // cloud metadata
    '224.0.0.1', // multicast
    '255.255.255.255',
  ]) {
    assert.equal(isDisallowedIp(ip, 4), true, `${ip} must be refused`);
  }
  assert.equal(isDisallowedIp('93.184.216.34', 4), false, 'an ordinary public address is allowed');
});

test('SECURITY: isDisallowedIp rejects the v4-in-v6 forms — ::ffff:169.254.169.254 reaches the same metadata endpoint as the bare literal', () => {
  assert.equal(isDisallowedIp('::1', 6), true);
  assert.equal(isDisallowedIp('::ffff:169.254.169.254', 6), true, 'IPv4-mapped metadata address');
  assert.equal(isDisallowedIp('::ffff:127.0.0.1', 6), true, 'IPv4-mapped loopback');
  assert.equal(isDisallowedIp('::127.0.0.1', 6), true, 'deprecated IPv4-compatible loopback');
  assert.equal(isDisallowedIp('fd00::1', 6), true, 'unique local');
  assert.equal(isDisallowedIp('fe80::1', 6), true, 'link-local');
  assert.equal(isDisallowedIp('64:ff9b::7f00:1', 6), true, 'NAT64 may embed a disallowed v4 target');
  assert.equal(isDisallowedIp('2606:2800:220:1:248:1893:25c8:1946', 6), false, 'public v6 is allowed');
});

// --- host allowlist ---------------------------------------------------------

test('SECURITY: hostAllowed matches exactly, and a bare entry never admits a lookalike domain', () => {
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('EXAMPLE.com', ['example.com']), true, 'case-insensitive');
  assert.equal(hostAllowed('example.com.', ['example.com']), true, 'trailing dot is the same host');
  assert.equal(
    hostAllowed('notexample.com', ['example.com']),
    false,
    'a bare entry is not a suffix wildcard — this is the classic allowlist bypass',
  );
  assert.equal(hostAllowed('evil.com/example.com', ['example.com']), false);
  assert.equal(hostAllowed('sub.example.com', ['example.com']), false, 'no implicit subdomains');
});

test('a dot-prefixed entry admits the domain and its subdomains, and nothing else', () => {
  assert.equal(hostAllowed('docs.example.org', ['.docs.example.org']), true);
  assert.equal(hostAllowed('a.docs.example.org', ['.docs.example.org']), true);
  assert.equal(hostAllowed('xdocs.example.org', ['.docs.example.org']), false);
});

// --- refusals: no request may be issued -------------------------------------

test('SECURITY: a non-https URL is refused without any request', async () => {
  const f = fetchStub([{ status: 200 }]);
  const out = await safeFetch('http://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.deepEqual(out, { kind: 'blocked', reason: 'scheme-not-https', detail: 'example.com' });
  assert.deepEqual(f.calls, [], 'SECURITY: no request may be issued to a refused target');
});

test('SECURITY: a host outside the allowlist is refused BEFORE it is resolved — the hostname never leaks to the resolver', async () => {
  const asked: string[] = [];
  const lookup: DnsLookupFn = async (h) => {
    asked.push(h);
    return PUBLIC;
  };
  const f = fetchStub([{ status: 200 }]);
  const out = await safeFetch('https://attacker.example/steal', POLICY, {
    lookup,
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal(out.kind, 'blocked');
  assert.equal((out as { reason: string }).reason, 'host-not-allowed');
  assert.deepEqual(asked, [], 'SECURITY: a disallowed host must not produce a DNS query');
  assert.deepEqual(f.calls, []);
});

test('SECURITY: an allowlisted host resolving to a private address is refused, and no request is issued', async () => {
  const f = fetchStub([{ status: 200 }]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': [{ address: '169.254.169.254', family: 4 }] }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'private-address');
  assert.deepEqual(f.calls, [], 'SECURITY: no request to a private address');
});

test('SECURITY: a host answering with BOTH a public and a private address is refused, not pinned to whichever came first', async () => {
  // Split-horizon DNS: returning one good address alongside an internal one
  // must not be usable to reach the internal one.
  const f = fetchStub([{ status: 200 }]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({
      'example.com': [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'private-address');
  assert.deepEqual(f.calls, []);
});

test('SECURITY: an empty allowlist refuses everything rather than meaning "any host"', async () => {
  const f = fetchStub([{ status: 200 }]);
  const out = await safeFetch(
    'https://example.com/x',
    { ...POLICY, allowHosts: [] },
    {
      lookup: lookupTo({ 'example.com': PUBLIC }),
      fetchImpl: f.impl,
      buildDispatcher: noopDispatcher,
    },
  );
  assert.equal((out as { reason: string }).reason, 'host-not-allowed');
  assert.deepEqual(f.calls, []);
});

// --- redirects --------------------------------------------------------------

test('SECURITY: a redirect to a non-allowlisted host is refused — the guard applies to every hop, not just the first', async () => {
  const f = fetchStub([
    { status: 302, headers: { location: 'https://attacker.example/collect' } },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'secret' },
  ]);
  const out = await safeFetch('https://example.com/start', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC, 'attacker.example': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'host-not-allowed');
  assert.equal(f.calls.length, 1, 'SECURITY: the redirect target must never be requested');
});

test('SECURITY: a redirect to a private address is refused even though the first hop was public', async () => {
  const f = fetchStub([
    { status: 301, headers: { location: 'https://docs.example.org/internal' } },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'internal' },
  ]);
  const out = await safeFetch('https://example.com/start', POLICY, {
    lookup: lookupTo({
      'example.com': PUBLIC,
      'docs.example.org': [{ address: '127.0.0.1', family: 4 }],
    }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'private-address');
  assert.equal(f.calls.length, 1);
});

test('SECURITY: each hop is pinned to its OWN resolved address — the dispatcher is rebuilt per hop, never reused', async () => {
  // The rebinding defence is per-hop. If hop 2 reused hop 1's pinned address
  // the guard would be checking one host and connecting to another.
  const pinned: string[] = [];
  const f = fetchStub([
    { status: 302, headers: { location: 'https://docs.example.org/next' } },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
  ]);
  const out = await safeFetch('https://example.com/start', POLICY, {
    lookup: lookupTo({
      'example.com': [{ address: '93.184.216.34', family: 4 }],
      'docs.example.org': [{ address: '151.101.1.140', family: 4 }],
    }),
    fetchImpl: f.impl,
    buildDispatcher: (addr) => {
      pinned.push(addr);
      return { close: async () => {} };
    },
  });
  assert.equal(out.kind, 'ok');
  assert.deepEqual(
    pinned,
    ['93.184.216.34', '151.101.1.140'],
    'SECURITY: hop 2 must connect to its own guard-checked address',
  );
});

test('SECURITY: the redirect chain is bounded — a loop cannot spin forever', async () => {
  const f = fetchStub([{ status: 302, headers: { location: 'https://example.com/again' } }]);
  const out = await safeFetch('https://example.com/start', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'redirect-cap');
  assert.equal(f.calls.length, POLICY.maxRedirects + 1, 'exactly maxRedirects+1 attempts, then refuse');
});

test('a relative Location is resolved against the current hop', async () => {
  const f = fetchStub([
    { status: 302, headers: { location: '/moved' } },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
  ]);
  const out = await safeFetch('https://example.com/start', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal(out.kind, 'ok');
  assert.equal(f.calls[1], 'https://example.com/moved');
});

// --- body handling ----------------------------------------------------------

test('SECURITY: a disallowed content type is refused from the HEADERS, before the body is read', async () => {
  const f = fetchStub([
    { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'binary' },
  ]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'content-type');
});

test('SECURITY: an oversize body with NO content-length is refused by the streaming cap', async () => {
  const big = 'x'.repeat(5000);
  // Verified: `new Response(string)` sets no content-length, so the
  // declared-length early exit cannot fire here — only the streaming cap can
  // catch this. That is the branch that matters, since chunked responses carry
  // no length at all.
  const f = fetchStub([{ status: 200, headers: { 'content-type': 'text/plain' }, body: big }]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'too-large');
});

test('SECURITY: an oversize body is refused up front when content-length declares it — no body is streamed at all', async () => {
  const f = fetchStub([
    {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '999999' },
      body: 'x'.repeat(50),
    },
  ]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'too-large');
});

test('SECURITY: a LYING content-length does not get a body past the cap — the stream is the enforcement, the header only an early exit', async () => {
  // The header claims the body is tiny; the body is 5x the cap. A checker that
  // trusted content-length would admit the whole thing.
  const f = fetchStub([
    {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '10' },
      body: 'x'.repeat(5000),
    },
  ]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'too-large', 'the streaming cap must catch it');
});

test('a body within the cap is returned decoded, with its byte count', async () => {
  const f = fetchStub([
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<p>hi</p>' },
  ]);
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal(out.kind, 'ok');
  assert.equal((out as { text: string }).text, '<p>hi</p>');
  assert.equal((out as { bytes: number }).bytes, 9);
  assert.equal((out as { contentType: string }).contentType, 'text/html; charset=utf-8');
});

// --- failure surfaces -------------------------------------------------------

test('a non-2xx status is reported as http-error, distinct from a policy refusal', async () => {
  const f = fetchStub([{ status: 404, headers: { 'content-type': 'text/plain' } }]);
  const out = await safeFetch('https://example.com/missing', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal(out.kind, 'http-error');
  assert.equal((out as { status: number }).status, 404);
});

test('a hostname that does not resolve is unreachable, NOT blocked — the distinction matters to callers', async () => {
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: async () => {
      throw new Error('ENOTFOUND');
    },
    fetchImpl: fetchStub([{ status: 200 }]).impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal(out.kind, 'unreachable');
  assert.equal((out as { reason: string }).reason, 'dns');
});

test('an aborted request surfaces as a timeout rather than a generic network error', async () => {
  const impl = (async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }) as unknown as typeof fetch;
  const out = await safeFetch('https://example.com/x', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal(out.kind, 'unreachable');
  assert.equal((out as { reason: string }).reason, 'timeout');
});

test('SECURITY: an unparseable URL is refused rather than coerced into something fetchable', async () => {
  const f = fetchStub([{ status: 200 }]);
  const out = await safeFetch('not a url', POLICY, {
    lookup: lookupTo({ 'example.com': PUBLIC }),
    fetchImpl: f.impl,
    buildDispatcher: noopDispatcher,
  });
  assert.equal((out as { reason: string }).reason, 'bad-url');
  assert.deepEqual(f.calls, []);
});
