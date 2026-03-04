const express = require('express');
const router = express.Router();

const { isAdmin } = require('../middleware/adminMiddleware');
const { renderAdmin } = require('../middleware/renderAdmin');
const { User } = require('../models/models');

const adminController = require('../controllers/adminController');
const priorityController = require('../controllers/priorityController');
const adminRouteController = require('../controllers/adminRouteController');
const adminStopController = require('../controllers/adminStopController');  

// DASHBOARD & PROFILE
router.get('/dashboard', isAdmin, (req, res) => renderAdmin(req, res, 'admin/dashboard', 'Tổng quan'));
router.get('/profile', isAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        renderAdmin(req, res, 'admin/profile', 'Hồ sơ Admin', { user });
    } catch (error) { res.redirect('/home'); }
});

// QUẢN LÝ TUYẾN
router.get('/routes', isAdmin, adminRouteController.getRoutesPage);
router.post('/routes/create', isAdmin, adminRouteController.createRoute);
router.post('/routes/:id/update', isAdmin, adminRouteController.updateRoute);
router.post('/routes/:id/deactivate', isAdmin, adminRouteController.deactivateRoute);
router.post('/routes/:id/activate', isAdmin, adminRouteController.activateRoute);

// QUẢN LÝ TRẠM
router.get('/stops', isAdmin, adminStopController.getStopsPage);
router.post('/stops/create', isAdmin, adminStopController.createStop);
router.post('/stops/:id/update', isAdmin, adminStopController.updateStop);
router.post('/stops/:id/deactivate', isAdmin, adminStopController.deactivateStop);
router.post('/stops/:id/activate', isAdmin, adminStopController.activateStop);

// HỒ SƠ ƯU TIÊN
router.get('/priority-profiles', isAdmin, priorityController.listProfiles);
router.get('/priority-profiles/:profileId', isAdmin, priorityController.viewProfileDetail);
router.post('/priority-profiles/:profileId/approve', isAdmin, priorityController.approveProfile);
router.post('/priority-profiles/:profileId/reject', isAdmin, priorityController.rejectProfile);

// NHÂN SỰ
router.get('/staff', isAdmin, adminController.getStaffList);
router.get('/staff/create', isAdmin, adminController.getCreateStaff);
router.post('/staff/create', isAdmin, adminController.createStaff);
router.post('/staff/:userId/toggle-lock', isAdmin, adminController.toggleLock);

module.exports = router;