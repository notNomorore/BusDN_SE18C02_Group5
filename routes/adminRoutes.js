const express = require('express');
const router = express.Router();

const adminRouteController = require('../controllers/adminRouteController');

// Nếu bạn có middleware phân quyền admin thì giữ lại
 const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');

// ===============================
// ROUTE PAGE - Quản lý tuyến xe
// ===============================
router.get('/routes', requireAuth, requireAdmin, adminRouteController.getRoutesPage);

// ===============================
// UC33 - Create Bus Route
// ===============================
router.post('/routes/create', requireAuth, requireAdmin, adminRouteController.createRoute);

module.exports = router;