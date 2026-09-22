/* Module 1 verification — exercises the auth API over HTTP, happy path and failures. */
const BASE = process.env.BASE || 'http://localhost:5000/api/v1';

let pass = 0;
let fail = 0;
const failures = [];

function chk(name, expected, actual) {
  if (expected === actual) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}  (expected ${expected}, got ${actual})`);
    failures.push(name);
    fail++;
  }
}

async function call(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, raw: JSON.stringify(json) };
}

const email = `driver.${Date.now()}@test.local`;
const password = 'DriverPass123';

console.log('=== REGISTER ===');
const reg = await call('POST', '/auth/register', {
  body: { name: 'Test Driver', email, password, phone: '9876543210' },
});
chk('register -> 201', 201, reg.status);
chk('role is driver', 'driver', reg.body?.data?.user?.role);
chk('status active', 'active', reg.body?.data?.user?.status);
chk('companyId null', true, reg.body?.data?.user?.companyId === null);
chk('token returned', true, typeof reg.body?.data?.token === 'string' && reg.body.data.token.length > 20);
chk('no passwordHash leaked', false, reg.raw.includes('passwordHash'));
chk('no hash value leaked', false, reg.raw.includes('$2b$') || reg.raw.includes('$2a$'));

console.log('=== REGISTER: failure cases ===');
const dup = await call('POST', '/auth/register', { body: { name: 'Dup', email, password } });
chk('duplicate email -> 409', 409, dup.status);
chk('duplicate errorCode', 'CONFLICT', dup.body?.errorCode);

const esc = await call('POST', '/auth/register', {
  body: { name: 'Sneaky', email: `esc.${Date.now()}@test.local`, password, role: 'super_admin' },
});
chk('privilege escalation -> 422', 422, esc.status);
chk('escalation errorCode', 'VALIDATION_ERROR', esc.body?.errorCode);

const esc2 = await call('POST', '/auth/register', {
  body: { name: 'Sneaky2', email: `esc2.${Date.now()}@test.local`, password, companyId: '507f1f77bcf86cd799439011' },
});
chk('companyId injection -> 422', 422, esc2.status);

const weak = await call('POST', '/auth/register', {
  body: { name: 'Weak', email: `weak.${Date.now()}@test.local`, password: 'short' },
});
chk('weak password -> 422', 422, weak.status);

const bademail = await call('POST', '/auth/register', {
  body: { name: 'Bad', email: 'not-an-email', password },
});
chk('invalid email -> 422', 422, bademail.status);
chk('validation lists field', 'email', bademail.body?.details?.[0]?.field);

const empty = await call('POST', '/auth/register', { body: {} });
chk('empty body -> 422', 422, empty.status);
chk('reports multiple fields', true, (empty.body?.details?.length ?? 0) >= 3);

console.log('=== LOGIN ===');
const login = await call('POST', '/auth/login', { body: { email, password } });
chk('login -> 200', 200, login.status);
chk('login returns token', true, typeof login.body?.data?.token === 'string');
chk('login no hash leaked', false, login.raw.includes('passwordHash'));
const token = login.body?.data?.token;

const upper = await call('POST', '/auth/login', { body: { email: email.toUpperCase(), password } });
chk('email case-insensitive -> 200', 200, upper.status);

console.log('=== LOGIN: failure cases ===');
const wrongPw = await call('POST', '/auth/login', { body: { email, password: 'WrongPassword1' } });
chk('wrong password -> 401', 401, wrongPw.status);
const unknown = await call('POST', '/auth/login', { body: { email: 'nobody@test.local', password } });
chk('unknown email -> 401', 401, unknown.status);
chk('same message for both (no user enumeration)', wrongPw.body?.message, unknown.body?.message);

console.log('=== /auth/me ===');
const noTok = await call('GET', '/auth/me');
chk('no token -> 401', 401, noTok.status);
chk('no token errorCode', 'UNAUTHORIZED', noTok.body?.errorCode);

const badTok = await call('GET', '/auth/me', { token: 'garbage.token.value' });
chk('invalid token -> 401', 401, badTok.status);
chk('invalid token errorCode', 'TOKEN_INVALID', badTok.body?.errorCode);

const noBearer = await fetch(`${BASE}/auth/me`, { headers: { Authorization: token } });
chk('missing Bearer prefix -> 401', 401, noBearer.status);

const me = await call('GET', '/auth/me', { token });
chk('valid token -> 200', 200, me.status);
chk('me returns correct user', email, me.body?.data?.user?.email);
chk('me role driver', 'driver', me.body?.data?.user?.role);
chk('me no hash leaked', false, me.raw.includes('passwordHash'));

console.log('=== MODULE 0 REGRESSION ===');
const health = await call('GET', '/health');
chk('health still 200', 200, health.status);
chk('health db name', 'ev_cms', health.body?.data?.database?.name);
const nf = await call('GET', '/auth/nonexistent');
chk('unknown auth route -> 404', 404, nf.status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failed:', failures.join(' | '));
  process.exit(1);
}
console.log(JSON.stringify({ testEmail: email, token }, null, 0));
