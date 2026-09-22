/* Module 10 — concurrency, exercised IN-PROCESS against the compiled services.
 *
 * These races cannot be driven over HTTP without adding a test-only endpoint that moves money,
 * which would be exactly the liability Module 7's D12 had to delete. So this script loads the
 * real compiled code from dist/, connects to the same database, and calls the same functions
 * the server calls — with genuine parallelism.
 *
 * Everything asserted here fails against a check-then-act implementation. */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(new URL('../../backend/', import.meta.url));
const mongoose = require('mongoose');

const { Wallet } = await import(new URL('../../backend/dist/models/wallet.model.js', import.meta.url).href);
const { WalletTransaction } = await import(new URL('../../backend/dist/models/walletTransaction.model.js', import.meta.url).href);
const { PaymentTransaction } = await import(new URL('../../backend/dist/models/paymentTransaction.model.js', import.meta.url).href);
const { ChargingSession } = await import(new URL('../../backend/dist/models/chargingSession.model.js', import.meta.url).href);
const payments = await import(new URL('../../backend/dist/services/payment.service.js', import.meta.url).href);
const wallets = await import(new URL('../../backend/dist/services/wallet.service.js', import.meta.url).href);

let pass = 0, fail = 0; const failures = [];
const chk = (name, expected, actual) => {
  const e = JSON.stringify(expected), a = JSON.stringify(actual);
  if (e === a) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${e}, got ${a})`); failures.push(name); fail++; }
};

const env = readFileSync(fileURLToPath(new URL('../../backend/.env', import.meta.url)), 'utf8');
const uri = env.split('\n').find((l) => l.startsWith('MONGODB_URI=')).slice('MONGODB_URI='.length).trim();
await mongoose.connect(uri);

const S = String(Date.now()).slice(-6);
const oid = () => new mongoose.Types.ObjectId();
const created = { wallets: [], sessions: [], users: [] };

/** A driver with a funded wallet and one priced, unpaid, completed session. */
async function fixture({ balancePaise, amountPaise }) {
  const userId = oid();
  created.users.push(userId);
  const wallet = await Wallet.create({ userId, balancePaise, status: 'active' });

  const session = await ChargingSession.create({
    userId,
    vehicleId: null,
    companyId: oid(),
    stationId: oid(),
    chargerId: oid(),
    connectorId: oid(),
    connectorNumber: 1,
    idTag: `RACE${S}${Math.random().toString(36).slice(2, 10)}`.toUpperCase().slice(0, 20),
    status: 'completed',
    requestedAt: new Date(),
    startedAt: new Date(Date.now() - 60000),
    endedAt: new Date(),
    startMeterWh: 0,
    lastMeterWh: 1000,
    endMeterWh: 1000,
    energyConsumedWh: 1000,
    appliedPricePerKwhPaise: amountPaise,
    amountPaise,
    paymentStatus: 'unpaid',
  });

  created.wallets.push(wallet._id);
  created.sessions.push(session._id);
  return { userId, wallet, session };
}

const balanceOf = async (id) => (await Wallet.findById(id)).balancePaise;

/* ------------------------------------------------------------------------ */
console.log('=== CONCURRENT SETTLEMENT — one session, many attempts ===');
{
  const { wallet, session } = await fixture({ balancePaise: 100000, amountPaise: 3000 });

  const results = await Promise.all(
    [0, 1, 2, 3, 4, 5, 6, 7].map(() => payments.settleSession(String(session._id))),
  );

  const paid = results.filter((r) => r.status === 'paid').length;

  chk('8 concurrent settlements: exactly ONE paid', 1, paid);
  chk('the wallet moved exactly once (₹1000 - ₹30)', 97000, await balanceOf(wallet._id));
  chk('exactly one debit ledger row', 1,
    await WalletTransaction.countDocuments({ chargingSessionId: session._id }));
  chk('exactly one payment record', 1,
    await PaymentTransaction.countDocuments({ chargingSessionId: session._id }));
  chk('the session is paid', 'paid', (await ChargingSession.findById(session._id)).paymentStatus);
}

/* ------------------------------------------------------------------------ */
console.log('\n=== CONCURRENT DEBITS — a wallet can never go negative ===');
{
  // ₹100 in the wallet, five sessions of ₹30 each = ₹150 of demand. Only three can succeed.
  const userId = oid();
  created.users.push(userId);
  const wallet = await Wallet.create({ userId, balancePaise: 10000, status: 'active' });
  created.wallets.push(wallet._id);

  /*
   * Fund it the way a real wallet is funded: with a matching CREDIT ledger row.
   *
   * The first version of this fixture set `balancePaise` directly, which made the reconcile
   * assertion fail - correctly. A balance that appeared without a ledger entry is exactly the
   * drift `reconcile` exists to detect, so the fixture was wrong, not the check.
   */
  await WalletTransaction.create({
    walletId: wallet._id, userId, type: 'recharge', direction: 'credit',
    amountPaise: 10000, balanceBeforePaise: 0, balanceAfterPaise: 10000,
    description: 'Opening balance for the race fixture',
  });

  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const session = await ChargingSession.create({
      userId, vehicleId: null, companyId: oid(), stationId: oid(), chargerId: oid(),
      connectorId: oid(), connectorNumber: 1,
      idTag: `RACEB${S}${i}${Math.random().toString(36).slice(2, 8)}`.toUpperCase().slice(0, 20),
      status: 'completed', requestedAt: new Date(), startedAt: new Date(Date.now() - 60000),
      endedAt: new Date(), startMeterWh: 0, lastMeterWh: 1000, endMeterWh: 1000,
      energyConsumedWh: 1000, appliedPricePerKwhPaise: 3000, amountPaise: 3000,
      paymentStatus: 'unpaid',
    });
    created.sessions.push(session._id);
    sessions.push(session);
  }

  const results = await Promise.all(sessions.map((s) => payments.settleSession(String(s._id))));
  const paid = results.filter((r) => r.status === 'paid').length;
  const finalBalance = await balanceOf(wallet._id);

  chk('₹100 wallet, 5 x ₹30 demanded: exactly 3 settled', 3, paid);
  chk('the balance is ₹10.00, not negative', 1000, finalBalance);
  chk('the balance is >= 0', true, finalBalance >= 0);
  chk('exactly 3 debit rows were written', 3,
    await WalletTransaction.countDocuments({ walletId: wallet._id, direction: 'debit' }));

  const reconciled = await wallets.reconcile(wallet._id);
  chk('the ledger still reconstructs the balance', true, reconciled.matches);
}

/* ------------------------------------------------------------------------ */
console.log('\n=== A SHORT WALLET LEAVES THE SESSION PENDING, NEVER FALSELY PAID ===');
{
  const { wallet, session } = await fixture({ balancePaise: 2000, amountPaise: 6000 });

  const result = await payments.settleSession(String(session._id));

  chk('settlement reports pending', 'pending', result.status);
  chk('the wallet is untouched', 2000, await balanceOf(wallet._id));
  chk('no ledger row was written', 0,
    await WalletTransaction.countDocuments({ chargingSessionId: session._id }));
  chk('the session is NOT paid', 'unpaid', (await ChargingSession.findById(session._id)).paymentStatus);

  const payment = await PaymentTransaction.findOne({ chargingSessionId: session._id });
  chk('a pending payment records why', 'pending', payment?.status);
  chk('with an attempt counted', true, (payment?.attempts ?? 0) >= 1);

  // Retrying must not spawn a second payment row.
  await payments.settleSession(String(session._id));
  await payments.settleSession(String(session._id));
  chk('repeated attempts reuse ONE payment row', 1,
    await PaymentTransaction.countDocuments({ chargingSessionId: session._id }));
  chk('and still never move money', 2000, await balanceOf(wallet._id));
}

/* ------------------------------------------------------------------------ */
console.log('\n=== A BLOCKED WALLET CANNOT BE DEBITED ===');
{
  const { wallet, session } = await fixture({ balancePaise: 100000, amountPaise: 3000 });
  await Wallet.updateOne({ _id: wallet._id }, { $set: { status: 'blocked' } });

  const result = await payments.settleSession(String(session._id));

  chk('settlement is deferred', 'pending', result.status);
  chk('the balance is untouched', 100000, await balanceOf(wallet._id));
}

/* ------------------------------------------------------------------- clean */
await ChargingSession.deleteMany({ _id: { $in: created.sessions } });
await PaymentTransaction.deleteMany({ chargingSessionId: { $in: created.sessions } });
await WalletTransaction.deleteMany({ walletId: { $in: created.wallets } });
await Wallet.deleteMany({ _id: { $in: created.wallets } });

/*
 * NOTIFICATIONS TOO — this suite fabricates user ids with `new ObjectId()` rather than
 * registering real accounts, because it is testing the settlement RACE in-process and does
 * not need a login. Settling a session fires `payment_success` / `payment_pending`
 * notifications for that id, and since the user never existed those rows were permanently
 * orphaned. The integrity suite caught 8 of them accumulating per run.
 */
const { Notification } = await import(new URL('../../backend/dist/models/notification.model.js', import.meta.url).href);
await Notification.deleteMany({ userId: { $in: created.users } });

await mongoose.disconnect();

console.log(`\n=========== SETTLEMENT RACE: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
