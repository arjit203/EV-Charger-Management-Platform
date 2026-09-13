/**
 * Root API router.
 *
 * Every future module mounts exactly one router here — auth, companies, stations,
 * chargers, sessions, wallet, and so on. Keeping one mount point per module is what
 * makes the URL surface predictable and the module boundaries visible in the code.
 */

import { Router } from 'express';
import healthRoutes from './health.routes';

const router = Router();

router.use('/health', healthRoutes);

export default router;
