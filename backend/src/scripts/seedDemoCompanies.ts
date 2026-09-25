/**
 * Seed the demo CPO network — five companies, their staff, sites and chargers — so the company
 * isolation can be exercised by hand in the browser rather than only by the automated suite.
 *
 * Run:  npm run seed:demo
 *
 * Idempotent: existing companies/users are left exactly as they are, including passwords.
 * Requires the super_admin from `npm run seed:admin` to exist first (companies record who
 * created them).
 */

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db';
import { Company } from '../models/company.model';
import { Station } from '../models/station.model';
import { Charger } from '../models/charger.model';
import { Tariff } from '../models/tariff.model';
import { Connector } from '../models/connector.model';
import { User } from '../models/user.model';
import { ROLES } from '../constants/roles';
import { logger } from '../utils/logger';
import { generateChargerToken, hashChargerToken } from '../utils/chargerToken';

const SCOPE = 'seed:demo';

const DEMO = [
  {
    name: 'Livanto Green',
    legalName: 'Livanto Green Energy Pvt Ltd',
    contactEmail: 'ops@livanto.local',
    address: { line1: '1 Connaught Place', city: 'New Delhi', state: 'Delhi', country: 'India', postalCode: '110001' },
    // Module 9. Integer PAISE per kWh — 1200 = ₹12.00/kWh, a realistic Indian DC rate.
    tariffName: 'Standard DC',
    pricePerKwhPaise: 1200,
    staff: [
      { name: 'Livanto CPO Admin', email: 'cpo@livanto.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'Livanto Operator', email: 'ops@livanto.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
    stations: [
      { name: 'Connaught Place', stationCode: 'DEL-CP-01', address: '1 Connaught Place', city: 'New Delhi', state: 'Delhi', country: 'India', postalCode: '110001', latitude: 28.6315, longitude: 77.2167, openingHours: '24x7',
        chargers: [
          { chargerCode: '01', name: 'Fast Charger 1', ocppId: 'LIV-DEL-CP-01-A', manufacturer: 'Delta', model: 'DC Wallbox 60', chargerType: 'DC', powerKw: 60, firmwareVersion: '1.4.2',
            connectors: [ { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 }, { connectorNumber: 2, connectorType: 'CHAdeMO', powerKw: 50 } ] },
          { chargerCode: '02', name: 'AC Charger 2', ocppId: 'LIV-DEL-CP-01-B', manufacturer: 'Exicom', model: 'AC Smart 22', chargerType: 'AC', powerKw: 22, firmwareVersion: '2.0.1',
            connectors: [ { connectorNumber: 1, connectorType: 'Type2', powerKw: 22 } ] },
        ] },
      { name: 'Aerocity Hub', stationCode: 'DEL-AC-02', address: 'Aerocity, IGI Airport', city: 'New Delhi', state: 'Delhi', country: 'India', postalCode: '110037', latitude: 28.5539, longitude: 77.1206, openingHours: '06:00-23:00',
        chargers: [
          { chargerCode: '01', name: 'Highway Fast 1', ocppId: 'LIV-DEL-AC-02-A', manufacturer: 'ABB', model: 'Terra 124', chargerType: 'DC', powerKw: 120, firmwareVersion: '3.1.0',
            connectors: [ { connectorNumber: 1, connectorType: 'CCS2', powerKw: 120 } ] },
        ] },
    ],
  },
  {
    name: 'Sharma Energy',
    legalName: 'Sharma Energy Solutions LLP',
    contactEmail: 'ops@sharma.local',
    address: { line1: '22 Andheri East', city: 'Mumbai', state: 'Maharashtra', country: 'India', postalCode: '400069' },
    // A different rate from Livanto, so a cross-company test can tell the two apart.
    tariffName: 'Mumbai Standard',
    pricePerKwhPaise: 1450,
    staff: [
      { name: 'Sharma CPO Admin', email: 'cpo@sharma.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'Sharma Operator', email: 'ops@sharma.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
    stations: [
      { name: 'Andheri East Plaza', stationCode: 'MUM-AE-01', address: '22 Andheri East', city: 'Mumbai', state: 'Maharashtra', country: 'India', postalCode: '400069', latitude: 19.1136, longitude: 72.8697, openingHours: '24x7',
        chargers: [
          { chargerCode: '01', name: 'Plaza DC 1', ocppId: 'SHA-MUM-AE-01-A', manufacturer: 'Delta', model: 'DC Wallbox 60', chargerType: 'DC', powerKw: 60, firmwareVersion: '1.4.2',
            connectors: [ { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 } ] },
        ] },
      { name: 'Bandra Kurla Complex', stationCode: 'MUM-BKC-02', address: 'G Block, Bandra Kurla Complex', city: 'Mumbai', state: 'Maharashtra', country: 'India', postalCode: '400051', latitude: 19.0660, longitude: 72.8677, openingHours: '07:00-22:00',
        chargers: [
          { chargerCode: '01', name: 'BKC AC 1', ocppId: 'SHA-MUM-BKC-02-A', manufacturer: 'Exicom', model: 'AC Smart 22', chargerType: 'AC', powerKw: 22, firmwareVersion: '2.0.1',
            connectors: [ { connectorNumber: 1, connectorType: 'Type2', powerKw: 22 } ] },
        ] },
    ],
  },
  /*
   * Three more operators so the platform view looks like a real multi-CPO network — six
   * companies, eight sites, ten chargers across five cities — instead of two. Names are
   * invented on purpose: a demo must never pass itself off as a real operator's network.
   */
  {
    name: 'VoltPath Charging',
    legalName: 'VoltPath Charging Solutions Pvt Ltd',
    contactEmail: 'ops@voltpath.local',
    address: { line1: '80 Feet Road, Koramangala', city: 'Bengaluru', state: 'Karnataka', country: 'India', postalCode: '560034' },
    tariffName: 'Bengaluru Standard',
    pricePerKwhPaise: 1350,
    staff: [
      { name: 'VoltPath CPO Admin', email: 'cpo@voltpath.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'VoltPath Operator', email: 'ops@voltpath.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
    stations: [
      { name: 'Koramangala Tech Park', stationCode: 'BLR-KR-01', address: '80 Feet Road, Koramangala 4th Block', city: 'Bengaluru', state: 'Karnataka', country: 'India', postalCode: '560034', latitude: 12.9352, longitude: 77.6245, openingHours: '24x7',
        chargers: [
          { chargerCode: '01', name: 'Koramangala DC 1', ocppId: 'VPC-BLR-KR-01-A', manufacturer: 'ABB', model: 'Terra 54', chargerType: 'DC', powerKw: 50, firmwareVersion: '2.4.0',
            connectors: [ { connectorNumber: 1, connectorType: 'CCS2', powerKw: 50 } ] },
        ] },
      { name: 'Whitefield Forum Mall', stationCode: 'BLR-WF-02', address: 'ITPL Main Road, Whitefield', city: 'Bengaluru', state: 'Karnataka', country: 'India', postalCode: '560066', latitude: 12.9698, longitude: 77.7500, openingHours: '10:00-22:00',
        chargers: [
          { chargerCode: '01', name: 'Mall AC 1', ocppId: 'VPC-BLR-WF-02-A', manufacturer: 'Delta', model: 'AC Mini Plus', chargerType: 'AC', powerKw: 7.4, firmwareVersion: '1.2.3',
            connectors: [ { connectorNumber: 1, connectorType: 'Type2', powerKw: 7.4 } ] },
        ] },
    ],
  },
  {
    name: 'Kaveri EV Networks',
    legalName: 'Kaveri EV Networks Pvt Ltd',
    contactEmail: 'ops@kaveriev.local',
    address: { line1: 'Rajiv Gandhi Salai, Sholinganallur', city: 'Chennai', state: 'Tamil Nadu', country: 'India', postalCode: '600119' },
    tariffName: 'Chennai Standard',
    pricePerKwhPaise: 1300,
    staff: [
      { name: 'Kaveri CPO Admin', email: 'cpo@kaveriev.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'Kaveri Operator', email: 'ops@kaveriev.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
    stations: [
      { name: 'OMR Sholinganallur', stationCode: 'CHE-OMR-01', address: 'Rajiv Gandhi Salai, Sholinganallur', city: 'Chennai', state: 'Tamil Nadu', country: 'India', postalCode: '600119', latitude: 12.9010, longitude: 80.2279, openingHours: '24x7',
        chargers: [
          { chargerCode: '01', name: 'OMR Fast 1', ocppId: 'KEV-CHE-OMR-01-A', manufacturer: 'Tritium', model: 'RTM 75', chargerType: 'DC', powerKw: 75, firmwareVersion: '4.0.2',
            connectors: [ { connectorNumber: 1, connectorType: 'CCS2', powerKw: 75 } ] },
          { chargerCode: '02', name: 'OMR AC 2', ocppId: 'KEV-CHE-OMR-01-B', manufacturer: 'Exicom', model: 'AC Smart 22', chargerType: 'AC', powerKw: 22, firmwareVersion: '2.0.1',
            connectors: [ { connectorNumber: 1, connectorType: 'Type2', powerKw: 22 } ] },
        ] },
    ],
  },
  {
    name: 'Deccan Charge Point',
    legalName: 'Deccan Charge Point LLP',
    contactEmail: 'ops@deccancharge.local',
    address: { line1: 'Rajiv Gandhi Infotech Park, Hinjewadi Phase 1', city: 'Pune', state: 'Maharashtra', country: 'India', postalCode: '411057' },
    tariffName: 'Pune Standard',
    pricePerKwhPaise: 1250,
    staff: [
      { name: 'Deccan CPO Admin', email: 'cpo@deccancharge.local', role: ROLES.CPO_ADMIN, password: 'Cpo@12345' },
      { name: 'Deccan Operator', email: 'ops@deccancharge.local', role: ROLES.OPERATOR, password: 'Ops@12345' },
    ],
    stations: [
      { name: 'Hinjewadi Phase 1', stationCode: 'PUN-HJ-01', address: 'Rajiv Gandhi Infotech Park, Phase 1', city: 'Pune', state: 'Maharashtra', country: 'India', postalCode: '411057', latitude: 18.5912, longitude: 73.7389, openingHours: '24x7',
        chargers: [
          { chargerCode: '01', name: 'Hinjewadi DC 1', ocppId: 'DCP-PUN-HJ-01-A', manufacturer: 'Delta', model: 'DC Wallbox 60', chargerType: 'DC', powerKw: 60, firmwareVersion: '1.4.2',
            connectors: [ { connectorNumber: 1, connectorType: 'CCS2', powerKw: 60 }, { connectorNumber: 2, connectorType: 'Type2', powerKw: 22 } ] },
        ] },
    ],
  },
] as const;

async function main(): Promise<void> {
  const connected = await connectDatabase();
  if (!connected) {
    logger.error(SCOPE, 'Could not connect to MongoDB. Check MONGODB_URI in backend/.env.');
    process.exit(1);
  }

  // Same guard rail as seed:admin — never write demo data into the wrong database.
  const dbName = mongoose.connection.name;
  if (dbName !== 'ev_cms') {
    logger.error(SCOPE, `Refusing to seed: connected to database "${dbName}", expected "ev_cms".`);
    await disconnectDatabase();
    process.exit(1);
  }

  const superAdmin = await User.findOne({ role: ROLES.SUPER_ADMIN }).select('_id');
  if (!superAdmin) {
    logger.error(SCOPE, 'No super_admin found. Run `npm run seed:admin` first.');
    await disconnectDatabase();
    process.exit(1);
  }

  for (const demo of DEMO) {
    let company = await Company.findOne({ name: demo.name });

    if (company) {
      logger.info(SCOPE, `Company "${demo.name}" already exists.`);
    } else {
      company = await Company.create({
        name: demo.name,
        legalName: demo.legalName,
        type: 'CPO',
        contactEmail: demo.contactEmail,
        address: demo.address,
        status: 'active',
        createdBy: superAdmin._id,
      });
      logger.info(SCOPE, `Created company "${demo.name}".`);
    }

    /*
     * MODULE 9 (flagged addition): every demo company needs an ACTIVE TARIFF, because a session
     * can no longer start at a company that has not published a price. Without this the seeded
     * demo would look broken the moment Module 9 shipped.
     *
     * Rates are in integer PAISE - 1200 is Rs12.00/kWh. Never rupees, never a float.
     */
    const existingTariff = await Tariff.findOne({ companyId: company._id, status: 'active' });

    if (existingTariff) {
      logger.info(SCOPE, `  tariff already active (${existingTariff.pricePerKwhPaise} paise/kWh)`);
    } else {
      const tariff = await Tariff.create({
        companyId: company._id,
        name: demo.tariffName,
        pricePerKwhPaise: demo.pricePerKwhPaise,
        status: 'active',
        createdBy: superAdmin._id,
      });
      logger.info(
        SCOPE,
        `  created tariff "${tariff.name}" at Rs${(tariff.pricePerKwhPaise / 100).toFixed(2)}/kWh`,
      );
    }

    for (const site of demo.stations) {
      const existingStation = await Station.findOne({
        companyId: company._id,
        stationCode: site.stationCode,
      }).select('_id');

      const { chargers: siteChargers, ...stationFields } = site;

      const station =
        existingStation ??
        (await Station.create({ ...stationFields, companyId: company._id, status: 'active', createdBy: superAdmin._id }));

      logger.info(
        SCOPE,
        existingStation
          ? `  station ${site.stationCode} already exists.`
          : `  created station ${site.stationCode} (${site.name})`,
      );

      for (const unit of siteChargers) {
        const { connectors: unitConnectors, ...chargerFields } = unit;

        const existingCharger = await Charger.findOne({ ocppId: unit.ocppId }).select('_id');
        if (existingCharger) {
          logger.info(SCOPE, `    charger ${unit.ocppId} already exists.`);
          continue;
        }

        // Module 6: every charger needs an OCPP connection token. It is stored hashed, so
        // this is the only moment the plaintext exists — print it for the simulator.
        const authToken = generateChargerToken();

        const charger = await Charger.create({
          ...chargerFields,
          stationId: station._id,
          companyId: company._id, // copied from the station's company, never from input
          status: 'available',
          authTokenHash: await hashChargerToken(authToken),
          createdBy: superAdmin._id,
        });
        logger.info(SCOPE, `    created charger ${unit.ocppId} (${unit.name})`);
        logger.warn(SCOPE, `      OCPP token: ${authToken}`);
        logger.warn(
          SCOPE,
          `      run: npm run dev -- --charger=${unit.ocppId} --token=${authToken}`,
        );

        for (const plug of unitConnectors) {
          await Connector.create({ ...plug, chargerId: charger._id, status: 'available' });
        }
        logger.info(SCOPE, `      added ${unitConnectors.length} connector(s)`);
      }
    }

    for (const member of demo.staff) {
      const existing = await User.findOne({ email: member.email }).select('_id');
      if (existing) {
        logger.info(SCOPE, `  user ${member.email} already exists.`);
        continue;
      }

      await User.create({
        name: member.name,
        email: member.email,
        passwordHash: await User.hashPassword(member.password),
        role: member.role,
        status: 'active',
        companyId: company._id,
      });
      logger.info(SCOPE, `  created ${member.email} (${member.role}) — password: ${member.password}`);
    }
  }

  logger.warn(SCOPE, 'Demo passwords are intentionally weak. Never use this data in production.');
  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error(SCOPE, 'Seeding failed', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
