/* Module 10 — arrears: may a driver who already owes money start another charge?

   IN-PROCESS, like the money suite, and for the same reason: the thing under test is a
   POLICY, and the honest way to test a policy is to hand it inputs directly rather than
   drive it through a charger. Reaching the count limit over HTTP would mean running four
   real sessions and waiting out a fifteen-minute grace window; here the debt is written with
   the age it needs and the answer is checked immediately.

   Requires `npm run build` in backend/ first. */

const { assessArrears } = await import(
  new URL('../../backend/dist/services/payment.service.js', import.meta.url).href
);
const { ARREARS_GRACE_MS, ARREARS_MAX_OUTSTANDING_PAISE, ARREARS_MAX_UNPAID_SESSIONS } =
  await import(new URL('../../backend/dist/constants/wallet.js', import.meta.url).href);
const { connectDatabase, disconnectDatabase } = await import(
  new URL('../../backend/dist/config/db.js', import.meta.url).href
);
const { ChargingSession } = await import(
  new URL('../../backend/dist/models/chargingSession.model.js', import.meta.url).href
);
const { Types } = await import(new URL('../../backend/node_modules/mongoose/index.js', import.meta.url).href);

let pass = 0, fail = 0; const failures = [];
const chk = (name, expected, actual) => {
  if (Object.is(expected, actual)) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${expected}, got ${actual})`); failures.push(name); fail++; }
};

await connectDatabase();

/* A synthetic user id that owns nothing else, so the suite can never disturb real rows and
   never has to guess which of them were its own. */
const DRIVER = new Types.ObjectId();
const AGED = ARREARS_GRACE_MS + 60_000;
const FRESH = 1_000;

/* Written straight to the collection rather than through the model: this is a FIXTURE, not a
   session the product created, and it needs an endedAt in the past that no legitimate code
   path would ever produce. */
async function owe(amountPaise, ageMs) {
  const at = new Date(Date.now() - ageMs);
  await ChargingSession.collection.insertOne({
    userId: DRIVER, companyId: new Types.ObjectId(), stationId: new Types.ObjectId(),
    chargerId: new Types.ObjectId(), connectorId: new Types.ObjectId(), connectorNumber: 1,
    idTag: 'arrears-test-' + Math.random().toString(36).slice(2, 10),
    status: 'completed', paymentStatus: 'unpaid', amountPaise, energyWh: 1000,
    requestedAt: at, startedAt: at, endedAt: at, createdAt: at, updatedAt: new Date(),
  });
}
const clear = () => ChargingSession.deleteMany({ userId: DRIVER });

try {
  console.log('=== A DRIVER WHO OWES NOTHING ===');
  chk('is not blocked', false, (await assessArrears(String(DRIVER))).blocked);
  chk('and owes zero', 0, (await assessArrears(String(DRIVER))).outstandingPaise);

  console.log('\n=== THE GRACE WINDOW: UNPAID IS NOT THE SAME AS NOT PAYING ===');
  await owe(ARREARS_MAX_OUTSTANDING_PAISE * 3, FRESH);
  const fresh = await assessArrears(String(DRIVER));
  chk('a debt younger than the grace window is not counted', 0, fresh.outstandingPaise);
  chk('   so a session that just ended cannot lock the driver out', false, fresh.blocked);
  chk('   (settlement is asynchronous — it may be paying right now)', null, fresh.reason);
  await clear();

  console.log('\n=== THE AMOUNT LIMIT ===');
  await owe(ARREARS_MAX_OUTSTANDING_PAISE, AGED);
  chk('debt exactly AT the limit does not block', false, (await assessArrears(String(DRIVER))).blocked);
  await clear();
  await owe(ARREARS_MAX_OUTSTANDING_PAISE + 1, AGED);
  const over = await assessArrears(String(DRIVER));
  chk('one paisa over it does', true, over.blocked);
  chk('   the amount is reported back', ARREARS_MAX_OUTSTANDING_PAISE + 1, over.outstandingPaise);
  chk('   the reason names the money owed', true, /₹/.test(over.reason ?? ''));
  chk('   and tells the driver how to fix it', true, /top up/i.test(over.reason ?? ''));
  await clear();

  console.log('\n=== THE COUNT LIMIT: MANY SMALL DEBTS ARE STILL A PATTERN ===');
  for (let i = 0; i < ARREARS_MAX_UNPAID_SESSIONS; i++) await owe(100, AGED);
  const atCount = await assessArrears(String(DRIVER));
  chk(`${ARREARS_MAX_UNPAID_SESSIONS} tiny aged debts do not block`, false, atCount.blocked);
  chk('   and stay far under the money limit', true, atCount.outstandingPaise < ARREARS_MAX_OUTSTANDING_PAISE);
  await owe(100, AGED);
  const overCount = await assessArrears(String(DRIVER));
  chk('   one more blocks on count alone', true, overCount.blocked);
  chk('   the reason names the session count', true, /unpaid charging sessions/.test(overCount.reason ?? ''));

  console.log('\n=== AGE IS PER-SESSION, NOT PER-DRIVER ===');
  await clear();
  await owe(100, AGED);
  await owe(ARREARS_MAX_OUTSTANDING_PAISE * 5, FRESH);
  const mixed = await assessArrears(String(DRIVER));
  chk('a fresh debt is ignored even beside an aged one', 100, mixed.outstandingPaise);
  chk('   so one old rupee does not drag a new charge into arrears', false, mixed.blocked);

  console.log('\n=== PAYING CLEARS THE BLOCK ===');
  await clear();
  for (let i = 0; i < ARREARS_MAX_UNPAID_SESSIONS + 1; i++) await owe(100, AGED);
  chk('blocked while unpaid', true, (await assessArrears(String(DRIVER))).blocked);
  await ChargingSession.updateMany({ userId: DRIVER }, { $set: { paymentStatus: 'paid' } });
  const settled = await assessArrears(String(DRIVER));
  chk('   settling every session unblocks immediately', false, settled.blocked);
  chk('   with nothing left owing', 0, settled.outstandingPaise);
  chk('   and no reason to show', null, settled.reason);
} finally {
  await clear();
  await disconnectDatabase();
}

console.log(`\n=========== ARREARS: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
