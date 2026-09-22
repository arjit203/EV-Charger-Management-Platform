/* Module 5 verification — chargers, connectors, and the Company→Station→Charger→Connector chain. */
const BASE = process.env.BASE || 'http://localhost:5000/api/v1';
const STAMP = Date.now();
const S = String(STAMP).slice(-6);
const PW = 'ChargerPass123';

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
console.log('=== SETUP: 2 companies, 2 stations, staff, driver ===');
const superToken = await login('admin@evcms.local', 'Admin@12345');

const mkCompany = async (label) => {
  const r = await call('POST', '/companies', { token: superToken, body: { name: `${label} ${STAMP}`, type: 'CPO' } });
  if (r.status !== 201) throw new Error(`company ${label}: ${r.status} ${r.raw}`);
  return r.body.data.company.id;
};
const A = await mkCompany('M5 Alpha');
const B = await mkCompany('M5 Beta');

const staff = {};
for (const [key, companyId, role] of [
  ['cpoA', A, 'cpo_admin'], ['opA', A, 'operator'],
  ['cpoB', B, 'cpo_admin'], ['opB', B, 'operator'],
]) {
  const email = `${key}.${STAMP}@test.local`;
  const r = await call('POST', '/users', { token: superToken, body: { name: `Staff ${key}`, email, password: PW, role, companyId } });
  chk(`create ${key} -> 201`, 201, r.status);
  staff[key] = { token: await login(email, PW) };
}
await call('POST', '/auth/register', { body: { name: 'Test Driver', email: `driver.${STAMP}@test.local`, password: PW } });
const driverToken = await login(`driver.${STAMP}@test.local`, PW);

const mkStation = async (companyId, code) => {
  const r = await call('POST', '/stations', {
    token: superToken,
    body: { name: `Station ${code}`, stationCode: code, address: '1 Main Road', city: 'New Delhi',
            state: 'Delhi', country: 'India', latitude: 28.6, longitude: 77.2, companyId },
  });
  if (r.status !== 201) throw new Error(`station ${code}: ${r.status} ${r.raw}`);
  return r.body.data.station.id;
};
const STA1 = await mkStation(A, `SA1-${S}`);
const STA2 = await mkStation(A, `SA2-${S}`);   // second site in company A, for the per-station code test
const STB1 = await mkStation(B, `SB1-${S}`);

const charger = (code, stationId, extra = {}) => ({
  stationId, name: `Charger ${code}`, chargerCode: code, ocppId: `OCPP-${code}`,
  manufacturer: 'Delta', model: 'DC Wallbox 60', chargerType: 'DC', powerKw: 60,
  firmwareVersion: '1.4.2', ...extra,
});

/* ------------------------------------------------------------- CHARGERS -- */
console.log('\n=== CHARGER BASICS ===');
const cA1 = await call('POST', '/chargers', { token: superToken, body: charger(`CA1-${S}`, STA1) });
chk('1. super_admin creates charger -> 201', 201, cA1.status);
chk('   companyId derived from station (not the body)', A, cA1.body?.data?.charger?.companyId);
chk('   status defaults to available', 'available', cA1.body?.data?.charger?.status);
chk('   chargerCode uppercased', true, /^CA1-/.test(cA1.body?.data?.charger?.chargerCode ?? ''));
const CA1 = cA1.body?.data?.charger?.id;

const cA2 = await call('POST', '/chargers', { token: staff.cpoA.token, body: charger(`CA2-${S}`, STA1) });
chk('5. cpo_admin creates charger in own station -> 201', 201, cA2.status);
chk('   companyId still derived from station', A, cA2.body?.data?.charger?.companyId);

const cB1 = await call('POST', '/chargers', { token: superToken, body: charger(`CB1-${S}`, STB1) });
chk('   super_admin creates charger in company B -> 201', 201, cB1.status);
const CB1 = cB1.body?.data?.charger?.id;

chk('2. super_admin views charger -> 200', 200, (await call('GET', `/chargers/${CA1}`, { token: superToken })).status);
const uc = await call('PATCH', `/chargers/${CA1}`, { token: superToken, body: { model: 'DC Wallbox 120', powerKw: 120 } });
chk('3. super_admin updates charger -> 200', 200, uc.status);
chk('   update applied', 120, uc.body?.data?.charger?.powerKw);
const sc = await call('PATCH', `/chargers/${CA1}/status`, { token: superToken, body: { status: 'maintenance' } });
chk('4. super_admin changes charger status -> 200', 200, sc.status);
chk('   status is maintenance', 'maintenance', sc.body?.data?.charger?.status);

/* ------------------------------------------ CREATION SECURITY (the chain) */
console.log('\n=== OWNERSHIP CHAIN: charger creation ===');
chk('6/23. cpo_admin_A cannot create in company B station -> 403', 403,
  (await call('POST', '/chargers', { token: staff.cpoA.token, body: charger(`HACK-${S}`, STB1) })).status);
chk('   operator_A cannot create at all -> 403', 403,
  (await call('POST', '/chargers', { token: staff.opA.token, body: charger(`OP-${S}`, STA1) })).status);
chk('10. driver cannot create -> 403', 403,
  (await call('POST', '/chargers', { token: driverToken, body: charger(`DRV-${S}`, STA1) })).status);
chk('11. invalid stationId format -> 422', 422,
  (await call('POST', '/chargers', { token: superToken, body: charger(`BAD-${S}`, 'not-an-id') })).status);
chk('12. non-existent station -> 404 (super_admin)', 404,
  (await call('POST', '/chargers', { token: superToken, body: charger(`NX-${S}`, '507f1f77bcf86cd799439011') })).status);
chk('12. non-existent station -> 403 (cpo_admin, no id probing)', 403,
  (await call('POST', '/chargers', { token: staff.cpoA.token, body: charger(`NX2-${S}`, '507f1f77bcf86cd799439011') })).status);

/* ------------------------------------------------------ UNIQUENESS RULES */
console.log('\n=== UNIQUENESS: ocppId global vs chargerCode per station ===');
chk('14. duplicate chargerCode at SAME station -> 409', 409,
  (await call('POST', '/chargers', { token: superToken, body: charger(`CA1-${S}`, STA1, { ocppId: `OCPP-OTHER-${S}` }) })).status);
chk('    SAME chargerCode at a DIFFERENT station -> 201 (unique per station)', 201,
  (await call('POST', '/chargers', { token: superToken, body: charger(`CA1-${S}`, STA2, { ocppId: `OCPP-STA2-${S}` }) })).status);
chk('    duplicate ocppId in the SAME company -> 409', 409,
  (await call('POST', '/chargers', { token: superToken, body: charger(`DUP1-${S}`, STA1, { ocppId: `OCPP-CA1-${S}` }) })).status);
chk('D1. duplicate ocppId ACROSS COMPANIES -> 409 (globally unique)', 409,
  (await call('POST', '/chargers', { token: superToken, body: charger(`DUP2-${S}`, STB1, { ocppId: `OCPP-CA1-${S}` }) })).status);

/* -------------------------------------------------- THE SCOPING MATRIX -- */
console.log('\n=== CHARGER SCOPING MATRIX ===');
for (const [label, token, eA, eB] of [
  ['super_admin', superToken, 200, 200],
  ['cpo_admin_A', staff.cpoA.token, 200, 403],
  ['operator_A', staff.opA.token, 200, 403],
  ['cpo_admin_B', staff.cpoB.token, 403, 200],
  ['operator_B', staff.opB.token, 403, 200],
  ['driver', driverToken, 403, 403],
]) {
  chk(`${label} -> charger A1`, eA, (await call('GET', `/chargers/${CA1}`, { token })).status);
  chk(`${label} -> charger B1`, eB, (await call('GET', `/chargers/${CB1}`, { token })).status);
}
chk('15. anonymous -> charger', 401, (await call('GET', `/chargers/${CA1}`)).status);

const listA = await call('GET', '/chargers?limit=100', { token: staff.cpoA.token });
chk('7/8. cpo_admin_A lists -> 200', 200, listA.status);
chk('    sees ONLY company A chargers', true,
  (listA.body?.data?.items ?? []).length > 0 && (listA.body?.data?.items ?? []).every((c) => c.companyId === A));
chk('    company B charger absent', false, (listA.body?.data?.items ?? []).some((c) => c.id === CB1));
chk('8. operator_A lists own company -> 200', 200, (await call('GET', '/chargers', { token: staff.opA.token })).status);
chk('9. operator_A cannot read company B charger -> 403', 403,
  (await call('GET', `/chargers/${CB1}`, { token: staff.opA.token })).status);
chk('   driver list -> 403', 403, (await call('GET', '/chargers', { token: driverToken })).status);
chk('   cpo_admin_A cannot filter to company B -> 403', 403,
  (await call('GET', `/chargers?companyId=${B}`, { token: staff.cpoA.token })).status);
chk('   filter by station works', true,
  ((await call('GET', `/chargers?stationId=${STA1}&limit=100`, { token: staff.cpoA.token })).body?.data?.items ?? [])
    .every((c) => c.stationId === STA1));
chk('   operator cannot update charger -> 403', 403,
  (await call('PATCH', `/chargers/${CA1}`, { token: staff.opA.token, body: { model: 'X' } })).status);
chk('   cpo_admin_A cannot update company B charger -> 403', 403,
  (await call('PATCH', `/chargers/${CB1}`, { token: staff.cpoA.token, body: { model: 'X' } })).status);

/* ------------------------------------------------------------ CONNECTORS */
console.log('\n=== CONNECTORS ===');
const conn = (n, type = 'CCS2', kw = 60) => ({ connectorNumber: n, connectorType: type, powerKw: kw });

const kA1 = await call('POST', `/chargers/${CA1}/connectors`, { token: superToken, body: conn(1) });
chk('15. create connector -> 201', 201, kA1.status);
chk('    bound to charger A1', CA1, kA1.body?.data?.connector?.chargerId);
chk('    status defaults to available', 'available', kA1.body?.data?.connector?.status);
const KA1 = kA1.body?.data?.connector?.id;

chk('    cpo_admin_A adds a second connector -> 201', 201,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: staff.cpoA.token, body: conn(2, 'Type2', 22) })).status);

const kB1 = await call('POST', `/chargers/${CB1}/connectors`, { token: superToken, body: conn(1) });
chk('    company B connector created -> 201', 201, kB1.status);
const KB1 = kB1.body?.data?.connector?.id;

const listK = await call('GET', `/chargers/${CA1}/connectors`, { token: staff.cpoA.token });
chk('16. list connectors -> 200', 200, listK.status);
chk('    returns both, ordered by number', '1,2', (listK.body?.data?.connectors ?? []).map((c) => c.connectorNumber).join(','));
chk('17. update connector -> 200', 200,
  (await call('PATCH', `/chargers/${CA1}/connectors/${KA1}`, { token: staff.cpoA.token, body: { powerKw: 90 } })).status);
const ks = await call('PATCH', `/chargers/${CA1}/connectors/${KA1}/status`, { token: staff.cpoA.token, body: { status: 'occupied' } });
chk('18. change connector status -> 200', 200, ks.status);
chk('    status is occupied', 'occupied', ks.body?.data?.connector?.status);
chk('19. duplicate connector number -> 409', 409,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: superToken, body: conn(1) })).status);

console.log('=== CONNECTOR OWNERSHIP (chain hop 3) ===');
chk('20. cpo_admin_A reads company B connector -> 403', 403,
  (await call('GET', `/chargers/${CB1}/connectors/${KB1}`, { token: staff.cpoA.token })).status);
chk('20. cpo_admin_A lists company B connectors -> 403', 403,
  (await call('GET', `/chargers/${CB1}/connectors`, { token: staff.cpoA.token })).status);
chk('24. cpo_admin_A creates connector on company B charger -> 403', 403,
  (await call('POST', `/chargers/${CB1}/connectors`, { token: staff.cpoA.token, body: conn(5) })).status);
chk('    cpo_admin_A updates company B connector -> 403', 403,
  (await call('PATCH', `/chargers/${CB1}/connectors/${KB1}`, { token: staff.cpoA.token, body: { powerKw: 10 } })).status);
chk('    connector B1 unchanged', 60,
  (await call('GET', `/chargers/${CB1}/connectors/${KB1}`, { token: superToken })).body?.data?.connector?.powerKw);
chk('    B connector id via A charger -> 404 (cross-charger)', 404,
  (await call('GET', `/chargers/${CA1}/connectors/${KB1}`, { token: superToken })).status);
chk('    operator_A can read own connectors -> 200', 200,
  (await call('GET', `/chargers/${CA1}/connectors`, { token: staff.opA.token })).status);
chk('    operator_A cannot create connector -> 403', 403,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: staff.opA.token, body: conn(6) })).status);
chk('22. driver cannot list connectors -> 403', 403,
  (await call('GET', `/chargers/${CA1}/connectors`, { token: driverToken })).status);
chk('22. driver cannot create connector -> 403', 403,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: driverToken, body: conn(7) })).status);
chk('    anonymous connectors -> 401', 401, (await call('GET', `/chargers/${CA1}/connectors`)).status);

/* ----------------------------------------- D7: NO STATUS CASCADE -------- */
console.log('\n=== D7: charger status does NOT cascade to connectors ===');
const before = (await call('GET', `/chargers/${CA1}/connectors`, { token: superToken })).body?.data?.connectors ?? [];
await call('PATCH', `/chargers/${CA1}/status`, { token: superToken, body: { status: 'maintenance' } });
const after = (await call('GET', `/chargers/${CA1}/connectors`, { token: superToken })).body?.data?.connectors ?? [];
chk('connector statuses unchanged after charger maintenance', true,
  JSON.stringify(before.map((c) => c.status)) === JSON.stringify(after.map((c) => c.status)));

/* ---------------------------------------------------------- VALIDATION -- */
console.log('\n=== VALIDATION ===');
chk('13. malformed chargerId -> 400', 400, (await call('GET', '/chargers/not-an-id', { token: superToken })).status);
chk('    non-existent charger -> 404 (super_admin)', 404,
  (await call('GET', '/chargers/507f1f77bcf86cd799439011', { token: superToken })).status);
chk('    non-existent charger -> 403 (cpo_admin)', 403,
  (await call('GET', '/chargers/507f1f77bcf86cd799439011', { token: staff.cpoA.token })).status);
chk('21. malformed chargerId on connectors -> 400', 400,
  (await call('GET', '/chargers/nope/connectors', { token: superToken })).status);
chk('    malformed connectorId -> 400', 400,
  (await call('GET', `/chargers/${CA1}/connectors/nope`, { token: superToken })).status);
chk('    powerKw 0 rejected -> 422', 422,
  (await call('POST', '/chargers', { token: superToken, body: charger(`PW0-${S}`, STA1, { powerKw: 0, ocppId: `OCPP-PW0-${S}` }) })).status);
chk('    bad chargerType -> 422', 422,
  (await call('POST', '/chargers', { token: superToken, body: charger(`BT-${S}`, STA1, { chargerType: 'HYBRID', ocppId: `OCPP-BT-${S}` }) })).status);
chk('    connectorNumber 0 -> 422', 422,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: superToken, body: conn(0) })).status);
chk('    connectorNumber 9 -> 422', 422,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: superToken, body: conn(9) })).status);
chk('    bad connectorType -> 422', 422,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: superToken, body: conn(4, 'USB-C') })).status);
chk('    chargerId in connector body rejected -> 422', 422,
  (await call('POST', `/chargers/${CA1}/connectors`, { token: superToken, body: { ...conn(5), chargerId: CB1 } })).status);
chk('    stationId in charger PATCH rejected -> 422', 422,
  (await call('PATCH', `/chargers/${CA1}`, { token: superToken, body: { stationId: STB1 } })).status);
chk('    companyId in charger PATCH rejected -> 422', 422,
  (await call('PATCH', `/chargers/${CA1}`, { token: superToken, body: { companyId: B } })).status);
chk('    status in charger PATCH rejected -> 422', 422,
  (await call('PATCH', `/chargers/${CA1}`, { token: superToken, body: { status: 'faulted' } })).status);
chk('    empty charger update -> 422', 422, (await call('PATCH', `/chargers/${CA1}`, { token: superToken, body: {} })).status);
chk('    bad charger status value -> 422', 422,
  (await call('PATCH', `/chargers/${CA1}/status`, { token: superToken, body: { status: 'exploded' } })).status);
// NOTE: 'charging' used to be invalid here. Module 6 added preparing/charging/finishing to
// the connector enum, because OCPP StatusNotification reports them — so this now asserts a
// value that is still genuinely invalid.
chk('    bad connector status value -> 422', 422,
  (await call('PATCH', `/chargers/${CA1}/connectors/${KA1}/status`, { token: superToken, body: { status: 'teleporting' } })).status);
chk('    connector status "charging" now VALID (Module 6 additive change) -> 200', 200,
  (await call('PATCH', `/chargers/${CA1}/connectors/${KA1}/status`, { token: superToken, body: { status: 'charging' } })).status);

console.log('=== 25. no DELETE endpoints (deactivate instead) ===');
chk('DELETE charger -> 404 (route does not exist)', 404, (await call('DELETE', `/chargers/${CA1}`, { token: superToken })).status);
chk('DELETE connector -> 404 (route does not exist)', 404,
  (await call('DELETE', `/chargers/${CA1}/connectors/${KA1}`, { token: superToken })).status);
chk('DELETE station -> 404 (Module 4, still no delete)', 404, (await call('DELETE', `/stations/${STA1}`, { token: superToken })).status);

/* ---------------------------------------------------------- REGRESSION -- */
console.log('\n=== MODULE 0-4 REGRESSION ===');
chk('26. health 200', 200, (await call('GET', '/health')).status);
chk('26. auth/me 200', 200, (await call('GET', '/auth/me', { token: staff.cpoA.token })).status);
chk('27. company isolation intact', 403, (await call('GET', `/companies/${B}`, { token: staff.cpoA.token })).status);
chk('28. user scoping intact', 403, (await call('GET', `/users?companyId=${B}`, { token: staff.cpoA.token })).status);
chk('28. driver vehicles intact', 200, (await call('GET', '/users/me/vehicles', { token: driverToken })).status);
chk('29. station scoping intact', 403, (await call('GET', `/stations/${STB1}`, { token: staff.cpoA.token })).status);
chk('29. station list intact', 200, (await call('GET', '/stations', { token: staff.cpoA.token })).status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('Failed:', failures.join(' | ')); process.exit(1); }
