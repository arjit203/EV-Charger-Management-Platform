/**
 * Root API router.
 *
 * Every future module mounts exactly one router here — auth, companies, stations,
 * chargers, sessions, wallet, and so on. Keeping one mount point per module is what
 * makes the URL surface predictable and the module boundaries visible in the code.
 */

import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import companyRoutes from './company.routes';
import userRoutes from './user.routes';
import stationRoutes from './station.routes';
import chargerRoutes from './charger.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/companies', companyRoutes);
router.use('/users', userRoutes);
router.use('/stations', stationRoutes);
router.use('/chargers', chargerRoutes);

export default router;
