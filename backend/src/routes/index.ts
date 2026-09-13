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
import sessionRoutes from './session.routes';
import tariffRoutes from './tariff.routes';
import paymentRoutes, { walletRouter } from './payment.routes';
import complaintRoutes from './complaint.routes';
import notificationRoutes from './notification.routes';
import analyticsRoutes from './analytics.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/companies', companyRoutes);
router.use('/users', userRoutes);
router.use('/stations', stationRoutes);
router.use('/chargers', chargerRoutes);
router.use('/charging', sessionRoutes);
router.use('/tariffs', tariffRoutes);
router.use('/wallet', walletRouter);
router.use('/payments', paymentRoutes);
router.use('/complaints', complaintRoutes);
router.use('/notifications', notificationRoutes);
router.use('/analytics', analyticsRoutes);

export default router;
