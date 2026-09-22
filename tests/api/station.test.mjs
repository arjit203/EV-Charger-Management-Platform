/* Module 4 verification — station CRUD, company scoping, and creation security. */
const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const STAMP = Date.now();
const PW = 'StationPass123';

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
const A = await mkCompany('M4 Alpha');
const B = await mkCompany('M4 Beta');

const staff = {};
for (const [key, companyId, role] of [
  ['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'],
  ['cpoB', B, 'cpo_admin'], ['opB', B, 'operator'],
]) {
  const email = `${key}.${STAMP}@test.local`;
  const r = await call('POST', '/users', { token: superToken, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  chk(`create ${key} -> 201`, 201, r.status);
  staff[key] = { email, token: await login(email, PW) };
}
const driverEmail = `driver.${STAMP}@test.local`;
await call('POST', '/auth/register', { body: { name: 'Test Driver', email: driverEmail, password: PW } });
const driverToken = await login(driverEmail, PW);

const station = (code, extra = {}) => ({
  name: `Station ${code}`, stationCode: code,
  address: '1 Connaught Place', city: 'New Delhi', state: 'Delhi', country: 'India', postalCode: '110001',
  latitude: 28.6315, longitude: 77.2167, ...extra,
});

/* --------------------------------------------------------------- BASIC -- */
console.log('\n=== BASIC (super_admin) ===');
const createA1 = await call('POST', '/stations', { token: superToken, body: station(`A1-${STAMP}`, { companyId: A }) });
chk('1. super_admin creates station -> 201', 201, createA1.status);
chk('   station bound to company A', A, createA1.body?.data?.station?.companyId);
chk('   status defaults to active', 'active', createA1.body?.data?.station?.status);
chk('   stationCode uppercased', true, /^A1-/.test(createA1.body?.data?.station?.stationCode ?? ''));
const A1 = createA1.body?.data?.station?.id;

const createA2 = await call('POST', '/stations', { token: staff.cpoA.token, body: station(`A2-${STAMP}`) });
chk('   cpo_admin_A creates station (no companyId sent) -> 201', 201, createA2.status);
chk('   companyId derived from token', A, createA2.body?.data?.station?.companyId);
const A2 = createA2.body?.data?.station?.id;

const createB1 = await call('POST', '/stations', { token: superToken, body: station(`B1-${STAMP}`, { companyId: B }) });
chk('13. super_admin creates station for company B -> 201', 201, createB1.status);
const B1 = createB1.body?.data?.station?.id;

chk('2. super_admin lists stations -> 200', 200, (await call('GET', '/stations?limit=100', { token: superToken })).status);
chk('3. super_admin views a station -> 200', 200, (await call('GET', `/stations/${A1}`, { token: superToken })).status);
const upd = await call('PATCH', `/stations/${A1}`, { token: superToken, body: { name: 'Renamed Station', openingHours: '24x7' } });
chk('4. super_admin updates a station -> 200', 200, upd.status);
chk('   update applied', 'Renamed Station', upd.body?.data?.station?.name);
const st = await call('PATCH', `/stations/${A1}/status`, { token: superToken, body: { status: 'inactive' } });
chk('5. super_admin changes status -> 200', 200, st.status);
chk('   status is inactive', 'inactive', st.body?.data?.station?.status);
await call('PATCH', `/stations/${A1}/status`, { token: superToken, body: { status: 'active' } });

/* ----------------------------------------------- THE SCOPING MATRIX ----- */
console.log('\n=== COMPANY SCOPING MATRIX ===');
const actors = [
  ['super_admin', superToken, 200, 200, 200],
  ['cpo_admin_A', staff.cpoA.token, 200, 200, 403],
  ['operator_A', staff.opA.token, 200, 200, 403],
  ['cpo_admin_B', staff.cpoB.token, 403, 403, 200],
  ['operator_B', staff.opB.token, 403, 403, 200],
  ['driver', driverToken, 403, 403, 403],
];
for (const [label, token, eA1, eA2, eB1] of actors) {
  chk(`${label} -> A1`, eA1, (await call('GET', `/stations/${A1}`, { token })).status);
  chk(`${label} -> A2`, eA2, (await call('GET', `/stations/${A2}`, { token })).status);
  chk(`${label} -> B1`, eB1, (await call('GET', `/stations/${B1}`, { token })).status);
}
chk('15. anonymous -> station', 401, (await call('GET', `/stations/${A1}`)).status);
chk('15. anonymous -> list', 401, (await call('GET', '/stations')).status);

console.log('=== LIST scoping ===');
const listA = await call('GET', '/stations?limit=100', { token: staff.cpoA.token });
chk('6. cpo_admin_A lists -> 200', 200, listA.status);
const itemsA = listA.body?.data?.items ?? [];
chk('7. cpo_admin_A sees ONLY company A', true, itemsA.length > 0 && itemsA.every((s) => s.companyId === A));
chk('   company B station absent from A list', false, itemsA.some((s) => s.id === B1));
const listOpA = await call('GET', '/stations?limit=100', { token: staff.opA.token });
chk('8. operator_A lists own company -> 200', 200, listOpA.status);
chk('9. operator_A sees only company A', true, (listOpA.body?.data?.items ?? []).every((s) => s.companyId === A));
const listB = await call('GET', '/stations?limit=100', { token: staff.cpoB.token });
chk('10. cpo_admin_B sees only company B', true, (listB.body?.data?.items ?? []).every((s) => s.companyId === B));
chk('   cpo_admin_A cannot filter to company B -> 403', 403,
  (await call('GET', `/stations?companyId=${B}`, { token: staff.cpoA.token })).status);
chk('   super_admin CAN filter by company', true,
  ((await call('GET', `/stations?companyId=${B}&limit=100`, { token: superToken })).body?.data?.items ?? [])
    .every((s) => s.companyId === B));

/* --------------------------------------------- CREATION SECURITY -------- */
console.log('\n=== CREATION SECURITY ===');
chk('11. cpo_admin_A cannot create under company B -> 403', 403,
  (await call('POST', '/stations', { token: staff.cpoA.token, body: station(`HACK-${STAMP}`, { companyId: B }) })).status);
chk('12. operator_A cannot create -> 403', 403,
  (await call('POST', '/stations', { token: staff.opA.token, body: station(`OP-${STAMP}`) })).status);
chk('    operator_A cannot update -> 403', 403,
  (await call('PATCH', `/stations/${A1}`, { token: staff.opA.token, body: { name: 'Operator Edit' } })).status);
chk('    operator_A cannot change status -> 403', 403,
  (await call('PATCH', `/stations/${A1}/status`, { token: staff.opA.token, body: { status: 'inactive' } })).status);
chk('    super_admin without companyId -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`NOCID-${STAMP}`) })).status);
chk('    unknown companyId -> 404', 404,
  (await call('POST', '/stations', { token: superToken, body: station(`UNK-${STAMP}`, { companyId: '507f1f77bcf86cd799439011' }) })).status);

/* ------------------------------------------------ ACCESS CONTROL -------- */
console.log('\n=== DRIVER HAS NO *ADMINISTRATIVE* STATION ACCESS ===');
chk('14. driver list -> 403', 403, (await call('GET', '/stations', { token: driverToken })).status);
chk('14. driver create -> 403', 403, (await call('POST', '/stations', { token: driverToken, body: station(`DRV-${STAMP}`) })).status);
chk('14. driver update -> 403', 403, (await call('PATCH', `/stations/${A1}`, { token: driverToken, body: { name: 'X Driver' } })).status);
chk('14. driver status -> 403', 403, (await call('PATCH', `/stations/${A1}/status`, { token: driverToken, body: { status: 'inactive' } })).status);
/* MODULE 14 CHANGED THIS CONTRACT ON PURPOSE.
 *
 * Module 4 asserted here that `/stations/public` DOES NOT EXIST, because a station with no
 * chargers or availability data was useless to a driver, and it deferred the endpoint to
 * "Module 5 or 14, whichever needs it first". Module 5 supplied the connectors, Module 6
 * gave them live status, and Module 14 built the map that needs them - so the deferral was
 * cashed in and a driver now gets 200 here.
 *
 * Everything ABOVE is unchanged: a driver still has no administrative access to stations.
 * The anonymous case below is unchanged too, which is the part worth keeping - "public"
 * describes the CONTENT of the response, not the access to it. */
chk('    driver CAN now reach public discovery (Module 14 built it)', 200,
  (await call('GET', '/stations/public', { token: driverToken })).status);
chk('    but "public" still requires a token (anonymous)', 401,
  (await call('GET', '/stations/public')).status);

/* ------------------------------------------- STATUS PERMISSION SPLIT ---- */
console.log('\n=== STATUS: inactive is the CPO switch, suspended is the platform sanction ===');
chk('cpo_admin_A CAN set inactive -> 200', 200,
  (await call('PATCH', `/stations/${A2}/status`, { token: staff.cpoA.token, body: { status: 'inactive' } })).status);
chk('cpo_admin_A CAN set active -> 200', 200,
  (await call('PATCH', `/stations/${A2}/status`, { token: staff.cpoA.token, body: { status: 'active' } })).status);
chk('cpo_admin_A CANNOT suspend -> 403', 403,
  (await call('PATCH', `/stations/${A2}/status`, { token: staff.cpoA.token, body: { status: 'suspended' } })).status);
chk('super_admin CAN suspend -> 200', 200,
  (await call('PATCH', `/stations/${A2}/status`, { token: superToken, body: { status: 'suspended' } })).status);
chk('cpo_admin_A CANNOT clear a platform suspension -> 403', 403,
  (await call('PATCH', `/stations/${A2}/status`, { token: staff.cpoA.token, body: { status: 'active' } })).status);
chk('super_admin CAN clear it -> 200', 200,
  (await call('PATCH', `/stations/${A2}/status`, { token: superToken, body: { status: 'active' } })).status);

/* ---------------------------------------------------------- VALIDATION -- */
console.log('\n=== VALIDATION ===');
chk('18. latitude 91 rejected -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`LAT-${STAMP}`, { companyId: A, latitude: 91 }) })).status);
chk('18. latitude -91 rejected -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`LAT2-${STAMP}`, { companyId: A, latitude: -91 }) })).status);
chk('19. longitude -181 rejected -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`LNG-${STAMP}`, { companyId: A, longitude: -181 }) })).status);
chk('19. longitude 181 rejected -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`LNG2-${STAMP}`, { companyId: A, longitude: 181 }) })).status);
chk('17. missing name -> 422', 422, (await call('POST', '/stations', { token: superToken, body: { companyId: A } })).status);
chk('17. missing city -> 422', 422, (await call('POST', '/stations', {
  token: superToken, body: { name: 'No City', stationCode: `NC-${STAMP}`, address: 'x road', state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId: A } })).status);
chk('20. invalid companyId format -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`BADC-${STAMP}`, { companyId: 'not-an-id' }) })).status);
chk('21. malformed stationId -> 400', 400, (await call('GET', '/stations/not-an-id', { token: superToken })).status);
chk('22. non-existent station -> 404 (super_admin)', 404,
  (await call('GET', '/stations/507f1f77bcf86cd799439011', { token: superToken })).status);
chk('    non-existent station -> 403 (cpo_admin, no id probing)', 403,
  (await call('GET', '/stations/507f1f77bcf86cd799439011', { token: staff.cpoA.token })).status);
chk('23. duplicate stationCode in SAME company -> 409', 409,
  (await call('POST', '/stations', { token: superToken, body: station(`A1-${STAMP}`, { companyId: A }) })).status);
chk('23. SAME stationCode in a DIFFERENT company -> 201 (unique per company)', 201,
  (await call('POST', '/stations', { token: superToken, body: station(`A1-${STAMP}`, { companyId: B }) })).status);
chk('    status via general PATCH rejected -> 422', 422,
  (await call('PATCH', `/stations/${A1}`, { token: superToken, body: { status: 'suspended' } })).status);
chk('    companyId via general PATCH rejected -> 422', 422,
  (await call('PATCH', `/stations/${A1}`, { token: superToken, body: { companyId: B } })).status);
chk('    unknown field rejected -> 422', 422,
  (await call('POST', '/stations', { token: superToken, body: station(`UNK2-${STAMP}`, { companyId: A, chargerCount: 5 }) })).status);
chk('    empty update -> 422', 422, (await call('PATCH', `/stations/${A1}`, { token: superToken, body: {} })).status);
chk('    bad status value -> 422', 422,
  (await call('PATCH', `/stations/${A1}/status`, { token: superToken, body: { status: 'broken' } })).status);

/* ---------------------------------------------------------- REGRESSION -- */
console.log('\n=== MODULE 0-3 REGRESSION ===');
chk('24. health 200', 200, (await call('GET', '/health')).status);
chk('24. auth/me 200', 200, (await call('GET', '/auth/me', { token: staff.cpoA.token })).status);
chk('25. company isolation intact', 403, (await call('GET', `/companies/${B}`, { token: staff.cpoA.token })).status);
chk('25. companies/me intact', 200, (await call('GET', '/companies/me', { token: staff.cpoA.token })).status);
chk('26. user scoping intact', 403, (await call('GET', `/users?companyId=${B}`, { token: staff.cpoA.token })).status);
chk('26. driver vehicles intact', 200, (await call('GET', '/users/me/vehicles', { token: driverToken })).status);
chk('    self-registration still driver-only', 422, (await call('POST', '/auth/register', {
  body: { name: 'Zed Test', email: `zed.${STAMP}@test.local`, password: PW, role: 'super_admin' } })).status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:', failures.join(' | ')); process.exit(1); }
