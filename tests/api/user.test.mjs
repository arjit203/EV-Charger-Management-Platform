/* Module 3 verification — user management, self-service, and vehicle ownership. */
const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const STAMP = Date.now();
const PW = 'UserPass12345';

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

/* ---------------------------------------------------------------- setup -- */
console.log('=== SETUP ===');
const superToken = await login('admin@evcms.local', 'Admin@12345');

const mkCompany = async (label) => {
  const r = await call('POST', '/companies', { token: superToken, body: { name: `${label} ${STAMP}`, type: 'CPO' } });
  if (r.status !== 201) throw new Error(`company ${label}: ${r.status} ${r.raw}`);
  return r.body.data.company.id;
};
const A = await mkCompany('M3 Alpha');
const B = await mkCompany('M3 Beta');

const staff = {};
for (const [key, companyId, role] of [
  ['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'],
  ['cpoB', B, 'cpo_admin'], ['opB', B, 'operator'],
]) {
  const email = `${key}.${STAMP}@test.local`;
  const r = await call('POST', '/users', { token: superToken, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  chk(`create ${key} via POST /users -> 201`, 201, r.status);
  chk(`${key} companyId bound`, companyId, r.body?.data?.user?.companyId);
  staff[key] = { email, id: r.body?.data?.user?.id, token: await login(email, PW) };
}

const drivers = {};
for (const key of ['a1', 'a2', 'b1']) {
  const email = `driver.${key}.${STAMP}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name: `Driver ${key}`, email, password: PW } });
  chk(`register driver ${key} -> 201`, 201, r.status);
  drivers[key] = { email, id: r.body?.data?.user?.id, token: r.body?.data?.token };
}
chk('drivers have no company', null, drivers.a1.id ? (await call('GET', '/auth/me', { token: drivers.a1.token })).body?.data?.user?.companyId : 'n/a');

/* ------------------------------------------------------- AUTHORIZATION -- */
console.log('\n=== ADMIN LIST / VIEW ===');
chk('super_admin lists users -> 200', 200, (await call('GET', '/users', { token: superToken })).status);
chk('super_admin sees company A staff', 200, (await call('GET', `/users?companyId=${A}`, { token: superToken })).status);
chk('super_admin sees company B staff', 200, (await call('GET', `/users?companyId=${B}`, { token: superToken })).status);

const listA = await call('GET', '/users?limit=100', { token: staff.cpoA.token });
chk('cpo_admin_A lists -> 200', 200, listA.status);
const itemsA = listA.body?.data?.items ?? [];
chk('cpo_admin_A sees ONLY company A', true, itemsA.length > 0 && itemsA.every((u) => u.companyId === A));
chk('cpo_admin_A sees ZERO drivers (D2)', 0, itemsA.filter((u) => u.role === 'driver').length);
chk('cpo_admin_A cannot filter to company B', 403, (await call('GET', `/users?companyId=${B}`, { token: staff.cpoA.token })).status);
chk('cpo_admin_A cannot request drivers', 403, (await call('GET', '/users?role=driver', { token: staff.cpoA.token })).status);

chk('cpo_admin_A views own staff -> 200', 200, (await call('GET', `/users/${staff.opA.id}`, { token: staff.cpoA.token })).status);
chk('cpo_admin_A views B staff -> 403', 403, (await call('GET', `/users/${staff.opB.id}`, { token: staff.cpoA.token })).status);
chk('cpo_admin_A views a driver -> 403', 403, (await call('GET', `/users/${drivers.a1.id}`, { token: staff.cpoA.token })).status);
chk('super_admin views B staff -> 200', 200, (await call('GET', `/users/${staff.opB.id}`, { token: superToken })).status);
chk('super_admin views a driver -> 200', 200, (await call('GET', `/users/${drivers.a1.id}`, { token: superToken })).status);

console.log('=== operator + driver have no admin access (D4) ===');
for (const [label, token] of [['operator_A', staff.opA.token], ['operator_B', staff.opB.token], ['driver_a1', drivers.a1.token]]) {
  chk(`${label} list -> 403`, 403, (await call('GET', '/users', { token })).status);
  chk(`${label} view other -> 403`, 403, (await call('GET', `/users/${staff.cpoA.id}`, { token })).status);
  chk(`${label} create -> 403`, 403, (await call('POST', '/users', { token, body: { name: 'Test User', email: `x.${label}.${STAMP}@test.local`, password: PW, role: 'operator', companyId: A } })).status);
}
chk('anonymous list -> 401', 401, (await call('GET', '/users')).status);
chk('anonymous view -> 401', 401, (await call('GET', `/users/${staff.cpoA.id}`)).status);

/* ----------------------------------------------------------- CREATE (D5) -- */
console.log('\n=== cpo_admin creating staff (D5) ===');
const okOp = await call('POST', '/users', {
  token: staff.cpoA.token, body: { name: 'Field Op', email: `fieldop.${STAMP}@test.local`, password: PW, role: 'operator' },
});
chk('cpo_admin_A creates operator -> 201', 201, okOp.status);
chk('companyId forced to own company', A, okOp.body?.data?.user?.companyId);

const hijack = await call('POST', '/users', {
  token: staff.cpoA.token, body: { name: 'Hijack', email: `hijack.${STAMP}@test.local`, password: PW, role: 'operator', companyId: B },
});
chk('cpo_admin_A cannot create into company B -> 403', 403, hijack.status);
chk('cpo_admin_A cannot create a cpo_admin -> 403', 403, (await call('POST', '/users', {
  token: staff.cpoA.token, body: { name: 'Clone', email: `clone.${STAMP}@test.local`, password: PW, role: 'cpo_admin' },
})).status);
for (const role of ['super_admin', 'driver', 'root']) {
  chk(`cannot create role "${role}" -> 422`, 422, (await call('POST', '/users', {
    token: superToken, body: { name: 'Test User', email: `r.${role}.${STAMP}@test.local`, password: PW, role, companyId: A },
  })).status);
}
chk('super_admin without companyId -> 422', 422, (await call('POST', '/users', {
  token: superToken, body: { name: 'Test User', email: `nocid.${STAMP}@test.local`, password: PW, role: 'operator' },
})).status);

/* --------------------------------------------------------- SELF-SERVICE -- */
console.log('\n=== SELF-SERVICE ===');
chk('driver reads self via /auth/me -> 200', 200, (await call('GET', '/auth/me', { token: drivers.a1.token })).status);
const patched = await call('PATCH', '/users/me', { token: drivers.a1.token, body: { name: 'Renamed Driver', phone: '9811122233' } });
chk('driver updates own profile -> 200', 200, patched.status);
chk('name actually changed', 'Renamed Driver', patched.body?.data?.user?.name);
chk('no hash leaked', false, patched.raw.includes('passwordHash'));

for (const [field, value] of [['role', 'super_admin'], ['companyId', A], ['status', 'active'], ['passwordHash', 'x'], ['email', 'new@test.local']]) {
  chk(`driver cannot PATCH own ${field} -> 422`, 422,
    (await call('PATCH', '/users/me', { token: drivers.a1.token, body: { [field]: value } })).status);
}
chk('empty profile update -> 422', 422, (await call('PATCH', '/users/me', { token: drivers.a1.token, body: {} })).status);
chk('driver cannot edit another user -> 403', 403,
  (await call('PATCH', `/users/${drivers.a2.id}`, { token: drivers.a1.token, body: { name: 'Hacked' } })).status);
chk('staff can also edit own profile -> 200', 200,
  (await call('PATCH', '/users/me', { token: staff.opA.token, body: { phone: '9800000001' } })).status);

/* ------------------------------------------------------------- STATUS --- */
console.log('\n=== STATUS ===');
chk('cpo_admin_A suspends own operator -> 200', 200,
  (await call('PATCH', `/users/${staff.opA.id}/status`, { token: staff.cpoA.token, body: { status: 'suspended' } })).status);
chk('suspended staff cannot log in', 403, (await call('POST', '/auth/login', { body: { email: staff.opA.email, password: PW } })).status);
chk('reactivate -> 200', 200,
  (await call('PATCH', `/users/${staff.opA.id}/status`, { token: staff.cpoA.token, body: { status: 'active' } })).status);
chk('cpo_admin_A cannot suspend B staff -> 403', 403,
  (await call('PATCH', `/users/${staff.opB.id}/status`, { token: staff.cpoA.token, body: { status: 'suspended' } })).status);
chk('cannot suspend yourself -> 403', 403,
  (await call('PATCH', `/users/${staff.cpoA.id}/status`, { token: staff.cpoA.token, body: { status: 'suspended' } })).status);
chk('bad status value -> 422', 422,
  (await call('PATCH', `/users/${staff.opA.id}/status`, { token: superToken, body: { status: 'deleted' } })).status);

/* ------------------------------------------------------------ VEHICLES -- */
console.log('\n=== VEHICLES: ownership ===');
const mkVehicle = (token, plate, extra = {}) => call('POST', '/users/me/vehicles', {
  token, body: { make: 'Tata', model: 'Nexon EV', registrationNumber: plate, connectorType: 'CCS2', batteryCapacityKwh: 40.5, ...extra },
});

const vA = await mkVehicle(drivers.a1.token, `DL01AB${String(STAMP).slice(-4)}`);
chk('driver creates vehicle -> 201', 201, vA.status);
chk('vehicle bound to creator', drivers.a1.id, vA.body?.data?.vehicle?.userId);
chk('registration uppercased', true, /^DL01AB/.test(vA.body?.data?.vehicle?.registrationNumber ?? ''));
const VA = vA.body?.data?.vehicle?.id;

const vB = await mkVehicle(drivers.b1.token, `MH02CD${String(STAMP).slice(-4)}`);
chk('second driver creates vehicle -> 201', 201, vB.status);
const VB = vB.body?.data?.vehicle?.id;

const listed = await call('GET', '/users/me/vehicles', { token: drivers.a1.token });
chk('driver lists own vehicles -> 200', 200, listed.status);
chk('list contains only own', true, (listed.body?.data?.vehicles ?? []).every((v) => v.userId === drivers.a1.id));
chk('driver_a2 sees no vehicles', 0, ((await call('GET', '/users/me/vehicles', { token: drivers.a2.token })).body?.data?.vehicles ?? []).length);

chk('driver reads own vehicle -> 200', 200, (await call('GET', `/users/me/vehicles/${VA}`, { token: drivers.a1.token })).status);
chk('driver updates own vehicle -> 200', 200,
  (await call('PATCH', `/users/me/vehicles/${VA}`, { token: drivers.a1.token, body: { model: 'Nexon EV Max' } })).status);

console.log('=== VEHICLES: cross-owner attempts (the core test) ===');
chk('driver_a1 READ vehicle B1 -> 404', 404, (await call('GET', `/users/me/vehicles/${VB}`, { token: drivers.a1.token })).status);
chk('driver_a1 UPDATE vehicle B1 -> 404', 404,
  (await call('PATCH', `/users/me/vehicles/${VB}`, { token: drivers.a1.token, body: { model: 'Stolen' } })).status);
chk('driver_a1 DELETE vehicle B1 -> 404', 404, (await call('DELETE', `/users/me/vehicles/${VB}`, { token: drivers.a1.token })).status);
const stillB = await call('GET', `/users/me/vehicles/${VB}`, { token: drivers.b1.token });
chk('vehicle B1 untouched', 'Nexon EV', stillB.body?.data?.vehicle?.model);
chk('vehicle B1 still active', true, stillB.body?.data?.vehicle?.isActive);

console.log('=== VEHICLES: ownership cannot be forged ===');
for (const field of ['userId', 'ownerId']) {
  chk(`${field} in create body -> 422`, 422,
    (await mkVehicle(drivers.a1.token, `XX00YY${String(STAMP).slice(-4)}`, { [field]: drivers.b1.id })).status);
}
chk('staff cannot use vehicle endpoints -> 403', 403, (await call('GET', '/users/me/vehicles', { token: staff.cpoA.token })).status);
chk('anonymous vehicles -> 401', 401, (await call('GET', '/users/me/vehicles')).status);

console.log('=== VEHICLES: soft delete ===');
const del = await call('DELETE', `/users/me/vehicles/${VA}`, { token: drivers.a1.token });
chk('deactivate -> 200', 200, del.status);
chk('isActive false', false, del.body?.data?.vehicle?.isActive);
chk('still retrievable (not destroyed)', 200, (await call('GET', `/users/me/vehicles/${VA}`, { token: drivers.a1.token })).status);
chk('reactivate via PATCH -> 200', 200,
  (await call('PATCH', `/users/me/vehicles/${VA}`, { token: drivers.a1.token, body: { isActive: true } })).status);

/* ---------------------------------------------------------- VALIDATION -- */
console.log('\n=== VALIDATION ===');
chk('invalid email on create -> 422', 422, (await call('POST', '/users', {
  token: superToken, body: { name: 'Test User', email: 'not-an-email', password: PW, role: 'operator', companyId: A } })).status);
chk('short password -> 422', 422, (await call('POST', '/users', {
  token: superToken, body: { name: 'Test User', email: `sp.${STAMP}@test.local`, password: 'abc', role: 'operator', companyId: A } })).status);
chk('duplicate email -> 409', 409, (await call('POST', '/users', {
  token: superToken, body: { name: 'Test User', email: staff.cpoA.email, password: PW, role: 'operator', companyId: A } })).status);
chk('unknown companyId -> 404', 404, (await call('POST', '/users', {
  token: superToken, body: { name: 'Test User', email: `uc.${STAMP}@test.local`, password: PW, role: 'operator', companyId: '507f1f77bcf86cd799439011' } })).status);
chk('short phone on profile -> 422', 422,
  (await call('PATCH', '/users/me', { token: drivers.a1.token, body: { phone: '12' } })).status);
chk('malformed user id -> 400', 400, (await call('GET', '/users/not-an-id', { token: superToken })).status);
chk('unknown user id -> 404 (super_admin)', 404, (await call('GET', '/users/507f1f77bcf86cd799439011', { token: superToken })).status);
chk('unknown user id -> 403 (cpo_admin, no id probing)', 403,
  (await call('GET', '/users/507f1f77bcf86cd799439011', { token: staff.cpoA.token })).status);
chk('malformed vehicle id -> 400', 400, (await call('GET', '/users/me/vehicles/nope', { token: drivers.a1.token })).status);
chk('bad connectorType -> 422', 422, (await mkVehicle(drivers.a2.token, `ZZ11ZZ${String(STAMP).slice(-4)}`, { connectorType: 'USB-C' })).status);
chk('missing make -> 422', 422, (await call('POST', '/users/me/vehicles', {
  token: drivers.a2.token, body: { model: 'X', registrationNumber: `QQ22QQ${String(STAMP).slice(-4)}`, connectorType: 'CCS2' } })).status);
chk('duplicate registration -> 409', 409,
  (await mkVehicle(drivers.a2.token, vA.body?.data?.vehicle?.registrationNumber)).status);

/* ---------------------------------------------------------- REGRESSION -- */
console.log('\n=== MODULE 0/1/2 REGRESSION ===');
chk('health 200', 200, (await call('GET', '/health')).status);
chk('auth/me 200', 200, (await call('GET', '/auth/me', { token: drivers.a1.token })).status);
chk('company isolation intact', 403, (await call('GET', `/companies/${B}`, { token: staff.cpoA.token })).status);
chk('companies/me intact', 200, (await call('GET', '/companies/me', { token: staff.cpoA.token })).status);
chk('self-registration still driver-only', 422, (await call('POST', '/auth/register', {
  body: { name: 'Zed', email: `zed.${STAMP}@test.local`, password: PW, role: 'super_admin' } })).status);
chk('retired stopgap route -> 404', 404, (await call('POST', `/companies/${A}/users`, {
  token: superToken, body: { name: 'Test User', email: `old.${STAMP}@test.local`, password: PW, role: 'operator' } })).status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:', failures.join(' | ')); process.exit(1); }
