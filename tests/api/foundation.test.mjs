/* MODULE 0 — the foundation nobody tested.
 *
 * Every other suite assumes these hold and none of them assert it: the health endpoint, the
 * error envelope, the 404 handler, security headers, and what happens when a client sends
 * something malformed.
 *
 * The envelope in particular is load-bearing. Fifteen modules and the whole frontend read
 * `{ success, message, errorCode, details }` — if its shape drifted, every error path in the
 * application would break at once and no existing suite would notice.
 */

const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const ORIGIN = BASE.replace(/\/api\/v\d+$/, '');

let passed = 0, failed = 0;
const fails = [];
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);

const raw = async (method, path, { body, headers = {}, token } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — that itself is a finding */ }
  return { status: res.status, json, text, headers: res.headers };
};

console.log('\n================ MODULE 0 — FOUNDATION ================');

/* ========================================================================= */
section('1. HEALTH — the one endpoint every deployment check calls');

{
  const r = await raw('GET', '/health');
  chk('health returns 200', 200, r.status);
  chk('and the success envelope', true, r.json?.success);
  chk('service names itself', 'ev-cms-backend', r.json?.data?.service);
  chk('status is ok', 'ok', r.json?.data?.status);
  chk('database state is reported', 'connected', r.json?.data?.database?.state);
  chk('database name is reported', true, typeof r.json?.data?.database?.name === 'string');
  chk('uptime is a number', true, typeof r.json?.data?.uptimeSeconds === 'number');
  chk('timestamp parses', true, !Number.isNaN(Date.parse(r.json?.data?.timestamp ?? '')));

  /* Health must never require a token — a load balancer has none. */
  chk('health needs no authentication', 200, (await raw('GET', '/health')).status);
}

/* ========================================================================= */
section('2. THE ERROR ENVELOPE — the contract 15 modules depend on');

{
  const r = await raw('GET', '/no-such-route');
  chk('unknown route returns 404', 404, r.status);
  chk('envelope says success:false', false, r.json?.success);
  chk('envelope carries a message', true, typeof r.json?.message === 'string' && r.json.message.length > 0);
  chk('envelope carries an errorCode', 'NOT_FOUND', r.json?.errorCode);
  chk('envelope has a details key', true, 'details' in (r.json ?? {}));
  chk('the message names the method and path', true, /GET .*no-such-route/.test(r.json?.message ?? ''));

  /* The exact key set. A new key appearing here means the frontend's one error handler,
   * written in Module 0 and never touched since, is reading a shape that has moved. */
  const keys = Object.keys(r.json ?? {}).filter((k) => k !== 'stack').sort();
  chk('the envelope keys are exactly the documented four',
    ['details', 'errorCode', 'message', 'success'], keys);
}

/* ========================================================================= */
section('3. MALFORMED INPUT IS THE CALLER\'S FAULT, NOT A 500');

{
  const r = await raw('POST', '/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  /* Regression pin for a Module 16 fix: this used to return 500 INTERNAL_ERROR, which both
   * blamed the server for a client mistake and let anyone fill the error log at will. */
  chk('malformed JSON returns 400, not 500', 400, r.status);
  chk('and is classified as a bad request', 'BAD_REQUEST', r.json?.errorCode);
  chk('and does not echo parser internals', false, /position \d+/.test(r.json?.message ?? ''));

  const empty = await raw('POST', '/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: '',
  });
  chk('an empty body is handled without a 500', true, empty.status < 500);

  const notJson = await raw('POST', '/auth/login', {
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  chk('a non-JSON content type does not 500', true, notJson.status < 500);

  /* 1 MB limit configured in app.ts. */
  const huge = await raw('POST', '/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(2 * 1024 * 1024) }),
  });
  chk('an oversized body is rejected without a 500', true, huge.status < 500);
  chk('and specifically as 413', 413, huge.status);
}

/* ========================================================================= */
section('4. AUTHENTICATION EDGES');

{
  chk('no token on a protected route -> 401', 401, (await raw('GET', '/companies')).status);
  chk('garbage token -> 401', 401, (await raw('GET', '/companies', { token: 'not.a.jwt' })).status);
  chk('empty bearer -> 401', 401, (await raw('GET', '/companies', { headers: { Authorization: 'Bearer ' } })).status);
  chk('wrong scheme -> 401', 401, (await raw('GET', '/companies', { headers: { Authorization: 'Basic abc' } })).status);

  /* Correctly signed shape, wrong signature. Proves the secret is actually verified. */
  const forged = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    + '.eyJzdWIiOiI2MTFmMWYxZjFmMWYxZjFmMWYxZjFmMWYiLCJyb2xlIjoic3VwZXJfYWRtaW4ifQ.wrong';
  chk('forged signature -> 401', 401, (await raw('GET', '/companies', { token: forged })).status);
}

/* ========================================================================= */
section('5. SECURITY HEADERS (helmet)');

{
  const r = await raw('GET', '/health');
  chk('X-Content-Type-Options: nosniff', 'nosniff', r.headers.get('x-content-type-options'));
  chk('X-Frame-Options is set', true, Boolean(r.headers.get('x-frame-options')));
  chk('Content-Security-Policy is set', true, Boolean(r.headers.get('content-security-policy')));
  chk('Strict-Transport-Security is set', true, Boolean(r.headers.get('strict-transport-security')));
  /* Helmet removes this; its presence would advertise the stack for free. */
  chk('X-Powered-By is NOT advertised', null, r.headers.get('x-powered-by'));
}

/* ========================================================================= */
section('6. CORS — an unlisted origin is refused');

{
  const allowed = await raw('GET', '/health', { headers: { Origin: 'http://localhost:3000' } });
  chk('the configured origin is allowed', 200, allowed.status);

  const denied = await raw('GET', '/health', { headers: { Origin: 'http://evil.example.com' } });
  chk('an unlisted origin is refused', true, denied.status >= 400);
  chk('and refused in the standard envelope, not an opaque crash', false, denied.json?.success);
}

/* ========================================================================= */
section('7. ROUTING BASICS');

{
  chk('the API prefix is required', 404, (await fetch(ORIGIN + '/companies')).status);
  chk('an unknown method on a real route does not 500', true,
    (await raw('DELETE', '/health')).status < 500);
  chk('a trailing-slash route still resolves', 200, (await raw('GET', '/health/')).status);
}

console.log(`\n================ MODULE 0: ${passed} passed, ${failed} failed ================`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
process.exit(failed === 0 ? 0 : 1);
