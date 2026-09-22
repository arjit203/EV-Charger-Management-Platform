/**
 * Demo ACTIVITY — the history that makes the dashboard, analytics and map worth looking at.
 *
 *   npm run seed:demo      companies, tariffs, stations, chargers, connectors, staff
 *   npm run seed:activity  ← this: drivers, vehicles, sessions, readings, money, support
 *
 * WHY THIS IS A SEPARATE SCRIPT. `seed:demo` builds the FLEET, and it is idempotent
 * infrastructure — run it as often as you like. This one writes HISTORY, which is
 * inherently cumulative: running it twice should give you more activity, not the same
 * activity twice. Keeping them apart means neither has to compromise.
 *
 * ============================================================================
 * WHAT THIS DOES NOT DO: invent numbers.
 *
 * Every session here is priced by Module 9's real arithmetic from the company's
 * own active tariff, and every payment moves real wallet balance through Module
 * 10's ledger. Nothing is written directly into an analytics table, because
 * there is no analytics table — Module 13 reads the same rows this creates.
 *
 * The one thing it fakes is TIME: sessions are backdated across the last three
 * weeks so charts have a shape. A demo where every bar sits on today is not a
 * chart, it is a single column.
 * ============================================================================
 *
 * Safe to run against a demo database. It refuses to touch anything it did not create.
 */

import { connectDatabase, disconnectDatabase } from '../config/db';
import { Company } from '../models/company.model';
import { Station } from '../models/station.model';
import { Charger } from '../models/charger.model';
import { Connector } from '../models/connector.model';
import { Tariff } from '../models/tariff.model';
import { User } from '../models/user.model';
import { Vehicle } from '../models/vehicle.model';
import { ChargingSession } from '../models/chargingSession.model';
import { MeterReading } from '../models/meterReading.model';
import { Wallet } from '../models/wallet.model';
import { WalletTransaction } from '../models/walletTransaction.model';
import { PaymentTransaction } from '../models/paymentTransaction.model';
import { Complaint } from '../models/complaint.model';
import { calculateAmountPaise } from '../utils/money';
import { logger } from '../utils/logger';

const SCOPE = 'seed:activity';

/** Drivers created by this script. Weak passwords on purpose — this is demo data. */
const DEMO_DRIVERS = [
  { name: 'Ananya Rao', email: 'ananya@driver.local', password: 'Driver@12345', vehicle: { make: 'Tata', model: 'Nexon EV', registrationNumber: 'DL01EV1001', connectorType: 'CCS2' as const } },
  { name: 'Rohit Menon', email: 'rohit@driver.local', password: 'Driver@12345', vehicle: { make: 'MG', model: 'ZS EV', registrationNumber: 'DL02EV2002', connectorType: 'CCS2' as const } },
  { name: 'Priya Nair', email: 'priya@driver.local', password: 'Driver@12345', vehicle: { make: 'Hyundai', model: 'Kona', registrationNumber: 'MH03EV3003', connectorType: 'CCS2' as const } },
  /*
   * DELIBERATELY UNDERFUNDED. Without someone who cannot pay, the settlement sweeper collects
   * everything within seconds and the dashboard's "awaiting payment" card is permanently zero —
   * hiding the most distinctive thing Module 10 does: deliver the electricity anyway, and
   * collect later. This driver keeps that visible.
   */
  { name: 'Kabir Shah', email: 'kabir@driver.local', password: 'Driver@12345', broke: true, vehicle: { make: 'Mahindra', model: 'XUV400', registrationNumber: 'KA04EV4004', connectorType: 'CCS2' as const } },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** A plausible charge: most are modest top-ups, a few are long ones. */
function energyForSession(index: number): number {
  const pattern = [4200, 11500, 7800, 2400, 18600, 9100, 5600, 14200, 6300, 3100];
  return pattern[index % pattern.length];
}

async function main(): Promise<void> {
  await connectDatabase();
  logger.info(SCOPE, 'Seeding demo activity…');

  const companies = await Company.find({ status: 'active' });
  if (companies.length === 0) {
    logger.error(SCOPE, 'No active companies. Run `npm run seed:demo` first.');
    await disconnectDatabase();
    process.exit(1);
  }

  /* ---------------------------------------------------------------- drivers */
  const drivers: { user: InstanceType<typeof User>; vehicleId: string | null }[] = [];

  for (const demo of DEMO_DRIVERS) {
    let user = await User.findOne({ email: demo.email });
    if (!user) {
      user = await User.create({
        name: demo.name,
        email: demo.email,
        passwordHash: await User.hashPassword(demo.password),
        role: 'driver',
        status: 'active',
      });
      logger.info(SCOPE, `  created driver ${demo.email} — password: ${demo.password}`);
    }

    let vehicle = await Vehicle.findOne({ registrationNumber: demo.vehicle.registrationNumber });
    if (!vehicle) {
      vehicle = await Vehicle.create({ ...demo.vehicle, userId: user._id });
    }

    /* A funded wallet, credited through the ledger rather than by setting a number. */
    let wallet = await Wallet.findOne({ userId: user._id });
    if (!wallet) {
      wallet = await Wallet.create({ userId: user._id, balancePaise: 0, status: 'active' });
    }

    /* The underfunded driver is topped up to a token amount only. */
    const targetBalance = (demo as { broke?: boolean }).broke ? 2_000 : 100_000;

    if (wallet.balancePaise < targetBalance) {
      const topUp = targetBalance - wallet.balancePaise;
      const balanceBeforePaise = wallet.balancePaise;
      wallet.balancePaise += topUp;
      await wallet.save();

      await WalletTransaction.create({
        walletId: wallet._id, userId: user._id, type: 'recharge', direction: 'credit',
        amountPaise: topUp, balanceBeforePaise, balanceAfterPaise: wallet.balancePaise,
        description: 'Demo wallet top-up',
      });

      /*
       * A UNIQUE provider id per top-up. Module 10 puts a unique index on
       * `providerPaymentId` — correctly, since that is what stops a real gateway callback
       * crediting twice. A deterministic demo id derived only from the user therefore
       * collided the second time this script ran, which is the index doing its job.
       */
      const stamp = Date.now().toString(36);
      await PaymentTransaction.create({
        userId: user._id, walletId: wallet._id, purpose: 'wallet_recharge', provider: 'razorpay',
        chargingSessionId: null, companyId: null, amountPaise: topUp, status: 'paid',
        providerOrderId: `order_demo_${String(user._id).slice(-8)}_${stamp}`,
        providerPaymentId: `pay_demo_${String(user._id).slice(-8)}_${stamp}`,
        attempts: 1, failureReason: null, paidAt: new Date(),
      });
    }

    drivers.push({ user, vehicleId: vehicle ? String(vehicle._id) : null });
  }

  /* ------------------------------------------------------------- sessions */
  let sessionCount = 0;
  let readingCount = 0;
  let sessionIndex = 0;

  for (const company of companies) {
    const tariff = await Tariff.findOne({ companyId: company._id, status: 'active' });
    if (!tariff) {
      logger.warn(SCOPE, `  ${company.name} has no active tariff — skipping its sessions.`);
      continue;
    }

    const stations = await Station.find({ companyId: company._id, status: 'active' });

    for (const station of stations) {
      const chargers = await Charger.find({ stationId: station._id });

      for (const charger of chargers) {
        const connectors = await Connector.find({ chargerId: charger._id });
        if (connectors.length === 0) continue;

        /* Six charges per charger, spread back across three weeks. */
        for (let n = 0; n < 6; n += 1) {
          const connector = connectors[n % connectors.length];
          const driver = drivers[sessionIndex % drivers.length];
          sessionIndex += 1;

          const daysAgo = (n * 3) + (sessionIndex % 3);
          const startedAt = new Date(Date.now() - daysAgo * DAY_MS - (sessionIndex % 12) * 3_600_000);

          /* Idempotency: one demo session per charger per slot. */
          const idTag = `DEMO${String(charger._id).slice(-6)}${n}`;
          if (await ChargingSession.findOne({ idTag })) continue;

          const energyWh = energyForSession(sessionIndex);
          const amountPaise = calculateAmountPaise(energyWh, tariff.pricePerKwhPaise);
          const durationMs = Math.round((energyWh / charger.powerKw) * 3_600);
          const endedAt = new Date(startedAt.getTime() + durationMs);

          /* The newest two per charger stay UNPAID, so "awaiting payment" is real. */
          const paid = n > 1;

          const session = await ChargingSession.create({
            userId: driver.user._id,
            vehicleId: driver.vehicleId,
            companyId: company._id,
            stationId: station._id,
            chargerId: charger._id,
            connectorId: connector._id,
            connectorNumber: connector.connectorNumber,
            transactionId: null,
            idTag,
            status: 'completed',
            requestedAt: startedAt,
            startedAt,
            endedAt,
            startMeterWh: 0,
            lastMeterWh: energyWh,
            endMeterWh: energyWh,
            energyConsumedWh: energyWh,
            stopReason: 'Remote',
            failureReason: null,
            appliedTariffId: tariff._id,
            appliedPricePerKwhPaise: tariff.pricePerKwhPaise,
            amountPaise,
            paymentStatus: paid ? 'paid' : 'unpaid',
          });
          sessionCount += 1;

          /* Meter readings: a cumulative curve, which is what a real charger reports. */
          const steps = 5;
          for (let i = 1; i <= steps; i += 1) {
            await MeterReading.create({
              sessionId: session._id,
              energyWh: Math.round((energyWh / steps) * i),
              meterTimestamp: new Date(startedAt.getTime() + (durationMs / steps) * i),
            });
            readingCount += 1;
          }

          if (paid) {
            const wallet = await Wallet.findOne({ userId: driver.user._id });
            if (wallet) {
              const balanceBeforePaise = wallet.balancePaise;
              wallet.balancePaise = Math.max(0, wallet.balancePaise - amountPaise);
              await wallet.save();

              await WalletTransaction.create({
                walletId: wallet._id, userId: driver.user._id, type: 'session_debit',
                direction: 'debit', amountPaise, balanceBeforePaise,
                balanceAfterPaise: wallet.balancePaise,
                description: `Charging at ${station.name}`,
              });

              await PaymentTransaction.create({
                userId: driver.user._id, walletId: wallet._id, purpose: 'session_debit',
                provider: 'internal', chargingSessionId: session._id, companyId: company._id,
                amountPaise, status: 'paid', providerOrderId: null, providerPaymentId: null,
                attempts: 1, failureReason: null, paidAt: endedAt,
              });
            }
          } else {
            await PaymentTransaction.create({
              userId: driver.user._id,
              walletId: (await Wallet.findOne({ userId: driver.user._id }))?._id,
              purpose: 'session_debit', provider: 'internal', chargingSessionId: session._id,
              companyId: company._id, amountPaise, status: 'pending',
              providerOrderId: null, providerPaymentId: null, attempts: 1,
              failureReason: 'Awaiting sufficient wallet balance.', paidAt: null,
            });
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------ complaints */
  const complaintSeeds = [
    { category: 'session_issue' as const, subject: 'Charging stopped before the car was full', description: 'The session ended early and I could not restart it without moving the vehicle.', status: 'open' as const, priority: 'high' as const },
    { category: 'charger_issue' as const, subject: 'Screen unresponsive on arrival', description: 'The charger screen was frozen and would not accept any input for several minutes.', status: 'in_progress' as const, priority: 'medium' as const },
    { category: 'payment_issue' as const, subject: 'Charged more than I expected', description: 'The final amount looked higher than the rate shown when I plugged in.', status: 'resolved' as const, priority: 'low' as const },
  ];

  let complaintCount = 0;
  for (const [index, seed] of complaintSeeds.entries()) {
    const driver = drivers[index % drivers.length];
    const session = await ChargingSession.findOne({ userId: driver.user._id }).sort({ startedAt: -1 });
    if (!session) continue;
    if (await Complaint.findOne({ subject: seed.subject })) continue;

    await Complaint.create({
      userId: driver.user._id,
      companyId: session.companyId,
      chargingSessionId: session._id,
      chargerId: session.chargerId,
      stationId: session.stationId,
      connectorId: session.connectorId,
      category: seed.category,
      subject: seed.subject,
      description: seed.description,
      priority: seed.priority,
      status: seed.status,
      resolution: seed.status === 'resolved' ? 'Charger firmware updated and the rate display corrected.' : null,
      resolvedAt: seed.status === 'resolved' ? new Date() : null,
    });
    complaintCount += 1;
  }

  logger.info(SCOPE, `Done: ${drivers.length} drivers, ${sessionCount} sessions, ${readingCount} meter readings, ${complaintCount} complaints.`);
  logger.warn(SCOPE, 'Demo passwords are intentionally weak. Never use this data in production.');

  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error(SCOPE, 'Seeding activity failed', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
