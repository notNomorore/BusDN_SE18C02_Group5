const express = require('express');
const router = express.Router();

const adminRouteController = require('../controllers/adminRouteController');
const adminStopController = require('../controllers/adminStopController');

const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');

// ===============================
// ROUTE PAGE - Quản lý tuyến xe
// ===============================
router.get('/routes', requireAuth, requireAdmin, adminRouteController.getRoutesPage);
router.post('/routes/create', requireAuth, requireAdmin, adminRouteController.createRoute);
router.post('/routes/:id/update', requireAuth, requireAdmin, adminRouteController.updateRoute);
router.post('/routes/:id/deactivate', requireAuth, requireAdmin, adminRouteController.deactivateRoute);
router.post('/routes/:id/activate', requireAuth, requireAdmin, adminRouteController.activateRoute);

// ===============================
// STOP PAGE - Quản lý trạm dừng
// ===============================
router.get('/stops', requireAuth, requireAdmin, adminStopController.getStopsPage);
router.post('/stops/create', requireAuth, requireAdmin, adminStopController.createStop);
router.post('/stops/:id/update', requireAuth, requireAdmin, adminStopController.updateStop);
router.post('/stops/:id/deactivate', requireAuth, requireAdmin, adminStopController.deactivateStop);
router.post('/stops/:id/activate', requireAuth, requireAdmin, adminStopController.activateStop);

module.exports = router;