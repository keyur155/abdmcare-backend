import { Router } from 'express';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

router.use(auditLog('NHCX'));