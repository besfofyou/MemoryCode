import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { login, me, register } from './auth.controller.js';

const router = Router();

// 公开路由
router.post('/register', register);
router.post('/login', login);

// 需要登录
router.get('/me', authenticate, me);

export default router;
