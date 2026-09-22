/* Module 2 verification — company CRUD, RBAC, and server-side company isolation. */
const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const STAMP = Date.now();

let pass = 0, fail = 0;
const failures = [];
const chk = (name, expected, actual) => {
  if (expected === actual) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${expected}, got ${actual})`); failures.push(name); fail++; }
};

async function call(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: JSON.stringify(json) };
}

const login = async (email, password) => {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.raw}`);
  return r.body.data.token;
};

const PW = 'CompanyPass123';

/* ---------------------------------------------------------------- setup -- */
console.log('=== SETUP: super_admin creates two companies ===');
const superToken = await login('admin@evcms.local', 'Admin@12345');

const createA = await call('POST', '/companies', {
  token: superToken,
  body: {
    name: `Livanto Green ${STAMP}`, legalName: 'Livanto Green Energy Pvt Ltd', type: 'CPO',
    contactEmail: `ops.a.${STAMP}@test.local`, contactPhone: '9876543210',
    address: { line1: '1 Connaught Place', city: 'New Delhi', state: 'Delhi', country: 'India', postalCode: '110001' },
  },
});
chk('create company A -> 201', 201, createA.status);
chk('company A status defaults active', 'active', createA.body?.data?.company?.status);
chk('company A type CPO', 'CPO', createA.body?.data?.company?.type);
chk('createdBy recorded', true, typeof createA.body?.data?.company?.createdBy === 'string');
const A = createA.body?.data?.company?.id;

const createB = await call('POST', '/companies', {
  token: superToken,
  body: { name: `Sharma Energy ${STAMP}`, type: 'CPO', contactEmail: `ops.b.${STAMP}@test.local` },
});
chk('create company B -> 201', 201, createB.status);
const B = createB.body?.data?.company?.id;

console.log('=== SETUP: create company-scoped staff ===');
const staff = {};
for (const [key, companyId, role] of [
  ['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'],
  ['cpoB', B, 'cpo_admin'], ['opB', B, 'operator'],
]) {
  const email = `${key}.${STAMP}@test.local`;
  const r = await call('POST', '/users', {
    token: superToken, body: { name: key, email, password: PW, role, companyId },
  });
  chk(`create ${key} (${role}) -> 201`, 201, r.status);
  chk(`${key} bound to correct company`, companyId, r.body?.data?.user?.companyId);
  chk(`${key} no hash leaked`, false, r.raw.includes('passwordHash'));
  staff[key] = { email, token: await login(email, PW) };
}

const driverEmail = `driver.${STAMP}@test.local`;
const driverReg = await call('POST', '/auth/register', { body: { name: 'Test Driver', email: driverEmail, password: PW } });
chk('register driver -> 201', 201, driverReg.status);
const driverToken = await login(driverEmail, PW);

/* ------------------------------------------------- THE ISOLATION MATRIX -- */
console.log('\n=== ISOLATION MATRIX: GET /companies/:id ===');
const actors = [
  ['super_admin', superToken, 200, 200],
  ['cpo_admin_A', staff.cpoA.token, 200, 403],
  ['operator_A', staff.opA.token, 200, 403],
  ['cpo_admin_B', staff.cpoB.token, 403, 200],
  ['operator_B', staff.opB.token, 403, 200],
  ['driver', driverToken, 403, 403],
];
for (const [label, token, expectA, expectB] of actors) {
  chk(`${label} -> company A`, expectA, (await call('GET', `/companies/${A}`, { token })).status);
  chk(`${label} -> company B`, expectB, (await call('GET', `/companies/${B}`, { token })).status);
}
chk('anonymous -> company A', 401, (await call('GET', `/companies/${A}`)).status);

console.log('=== ISOLATION: GET /companies (platform-wide list) ===');
chk('super_admin lists all -> 200', 200, (await call('GET', '/companies', { token: superToken })).status);
chk('cpo_admin_A list -> 403', 403, (await call('GET', '/companies', { token: staff.cpoA.token })).status);
chk('operator_A list -> 403', 403, (await call('GET', '/companies', { token: staff.opA.token })).status);
chk('driver list -> 403', 403, (await call('GET', '/companies', { token: driverToken })).status);
chk('anonymous list -> 401', 401, (await call('GET', '/companies')).status);

console.log('=== ISOLATION: GET /companies/me ===');
const meA = await call('GET', '/companies/me', { token: staff.cpoA.token });
chk('cpo_admin_A /me -> 200', 200, meA.status);
chk('cpo_admin_A /me returns company A', A, meA.body?.data?.company?.id);
const meOpB = await call('GET', '/companies/me', { token: staff.opB.token });
chk('operator_B /me returns company B', B, meOpB.body?.data?.company?.id);
chk('super_admin /me -> 403 (no company)', 403, (await call('GET', '/companies/me', { token: superToken })).status);
chk('driver /me -> 403', 403, (await call('GET', '/companies/me', { token: driverToken })).status);

/* ------------------------------------------------------ super_admin CRUD -- */
console.log('\n=== super_admin CRUD ===');
const listed = await call('GET', `/companies?search=Livanto%20Green%20${STAMP}`, { token: superToken });
chk('search finds company A', 1, listed.body?.data?.items?.length);
chk('pagination fields present', true,
  typeof listed.body?.data?.total === 'number' && typeof listed.body?.data?.totalPages === 'number');

const upd = await call('PATCH', `/companies/${A}`, {
  token: superToken, body: { legalName: 'Livanto Green Energy Limited', contactPhone: '9000000000' },
});
chk('update company -> 200', 200, upd.status);
chk('update applied', 'Livanto Green Energy Limited', upd.body?.data?.company?.legalName);

chk('cpo_admin cannot update own company -> 403', 403,
  (await call('PATCH', `/companies/${A}`, { token: staff.cpoA.token, body: { legalName: 'Hacked' } })).status);
chk('cpo_admin_A cannot update company B -> 403', 403,
  (await call('PATCH', `/companies/${B}`, { token: staff.cpoA.token, body: { legalName: 'Hacked' } })).status);

/* ----------------------------------------------------------- validation -- */
console.log('\n=== VALIDATION / ERROR HANDLING ===');
chk('malformed company id -> 400', 400, (await call('GET', '/companies/not-an-id', { token: superToken })).status);
chk('non-existent company -> 404', 404,
  (await call('GET', '/companies/507f1f77bcf86cd799439011', { token: superToken })).status);
chk('duplicate company name -> 409', 409,
  (await call('POST', '/companies', { token: superToken, body: { name: `Livanto Green ${STAMP}` } })).status);
chk('missing name -> 422', 422, (await call('POST', '/companies', { token: superToken, body: {} })).status);
chk('unknown field rejected -> 422', 422,
  (await call('POST', '/companies', { token: superToken, body: { name: `X ${STAMP}`, saasFeePercent: 15 } })).status);
chk('status via general PATCH rejected -> 422', 422,
  (await call('PATCH', `/companies/${A}`, { token: superToken, body: { status: 'suspended' } })).status);
chk('empty update -> 422', 422, (await call('PATCH', `/companies/${A}`, { token: superToken, body: {} })).status);
chk('bad company type -> 422', 422,
  (await call('POST', '/companies', { token: superToken, body: { name: `Y ${STAMP}`, type: 'BANK' } })).status);

console.log('=== PRIVILEGE ESCALATION via staff endpoint ===');
for (const [label, role, expected] of [
  ['super_admin', 'super_admin', 422], ['driver', 'driver', 422], ['nonsense', 'root', 422],
]) {
  const r = await call('POST', '/users', {
    token: superToken, body: { name: 'Test User', email: `esc.${label}.${STAMP}@test.local`, password: PW, role, companyId: A },
  });
  chk(`cannot assign role "${role}" -> 422`, expected, r.status);
}
chk('unknown field on create rejected -> 422', 422, (await call('POST', '/users', {
  token: superToken,
  body: { name: 'Test User', email: `esc.cid.${STAMP}@test.local`, password: PW, role: 'operator', companyId: A, status: 'active' },
})).status);
chk('cpo_admin cannot create a cpo_admin -> 403', 403, (await call('POST', '/users', {
  token: staff.cpoA.token, body: { name: 'Test User', email: `esc.cpo.${STAMP}@test.local`, password: PW, role: 'cpo_admin' },
})).status);
chk('old stopgap route is gone -> 404', 404, (await call('POST', `/companies/${A}/users`, {
  token: superToken, body: { name: 'Test User', email: `gone.${STAMP}@test.local`, password: PW, role: 'operator' },
})).status);

/* ------------------------------------------------- SUSPENSION (LIVE) ----- */
console.log('\n=== SUSPENDED COMPANY: live enforcement on pre-existing tokens ===');
const tokenBeforeSuspension = staff.cpoB.token;
chk('cpo_admin_B works before suspension', 200,
  (await call('GET', '/companies/me', { token: tokenBeforeSuspension })).status);

const susp = await call('PATCH', `/companies/${B}/status`, { token: superToken, body: { status: 'suspended' } });
chk('suspend company B -> 200', 200, susp.status);
chk('company B now suspended', 'suspended', susp.body?.data?.company?.status);

const afterSusp = await call('GET', '/companies/me', { token: tokenBeforeSuspension });
chk('SAME token now refused -> 403', 403, afterSusp.status);
chk('errorCode COMPANY_SUSPENDED', 'COMPANY_SUSPENDED', afterSusp.body?.errorCode);
chk('operator_B also refused -> 403', 403,
  (await call('GET', `/companies/${B}`, { token: staff.opB.token })).status);
chk('suspended-company staff CAN still log in', 200,
  (await call('POST', '/auth/login', { body: { email: staff.cpoB.email, password: PW } })).status);
chk('their /auth/me still works (identity unaffected)', 200,
  (await call('GET', '/auth/me', { token: tokenBeforeSuspension })).status);
chk('super_admin can still read suspended company', 200,
  (await call('GET', `/companies/${B}`, { token: superToken })).status);
chk('company A unaffected by B suspension', 200,
  (await call('GET', '/companies/me', { token: staff.cpoA.token })).status);

const react = await call('PATCH', `/companies/${B}/status`, { token: superToken, body: { status: 'active' } });
chk('reactivate company B -> 200', 200, react.status);
chk('cpo_admin_B works again with the ORIGINAL token', 200,
  (await call('GET', '/companies/me', { token: tokenBeforeSuspension })).status);
chk('bad status value -> 422', 422,
  (await call('PATCH', `/companies/${B}/status`, { token: superToken, body: { status: 'deleted' } })).status);
chk('cpo_admin cannot change status -> 403', 403,
  (await call('PATCH', `/companies/${B}/status`, { token: staff.cpoB.token, body: { status: 'active' } })).status);

/* ------------------------------------------------- MODULE 0/1 REGRESSION -- */
console.log('\n=== MODULE 0 + 1 REGRESSION ===');
const health = await call('GET', '/health');
chk('health still 200', 200, health.status);
chk('health db ev_cms', 'ev_cms', health.body?.data?.database?.name);
const me = await call('GET', '/auth/me', { token: staff.cpoA.token });
chk('/auth/me still works', 200, me.status);
chk('JWT carries role', 'cpo_admin', me.body?.data?.user?.role);
chk('JWT carries companyId', A, me.body?.data?.user?.companyId);
chk('driver self-register still driver-only', 422, (await call('POST', '/auth/register', {
  body: { name: 'Z', email: `z.${STAMP}@test.local`, password: PW, role: 'super_admin' },
})).status);
chk('unknown route still 404', 404, (await call('GET', '/companies/../nope', { token: superToken })).status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:', failures.join(' | ')); process.exit(1); }
