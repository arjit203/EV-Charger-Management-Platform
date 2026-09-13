import { Router } from 'express';

import { login, me, register } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { loginSchema, registerSchema } from '../validators/auth.validator';

const router = Router();

/** Public self-registration. Creates a `driver` and nothing else. */
router.post('/register', validateBody(registerSchema), register);

/** Public login. */
router.post('/login', validateBody(loginSchema), login);

/** The caller's own profile. */
router.get('/me', authenticate, me);

export default router;
