import { Router } from 'express';
import { getHealth } from '../controllers/health.controller';

const router = Router();

/** GET {API_PREFIX}/health — liveness + database state. Public, no auth. */
router.get('/', getHealth);

export default router;
