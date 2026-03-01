const express = require('express');
const router = express.Router();

// --- 1. IMPORT MIDDLEWARE & CONTROLLERS ---
const { isAdmin } = require('../middleware/adminMiddleware');
const { renderAdmin } = require('../middleware/renderAdmin');
const { User, PriorityProfile } = require('../models/models');
const adminController = require('../controllers/adminController');
const priorityController = require('../controllers/priorityController');
const adminRouteController = require('../controllers/adminRouteController');
const adminStopController = require('../controllers/adminStopController');  

// --- 2. TỔNG QUAN & HỒ SƠ (Admin Dashboard) ---
router.get('/dashboard', isAdmin, (req, res) => renderAdmin(req, res, 'admin/dashboard', 'Tổng quan'));

router.get('/profile', isAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        renderAdmin(req, res, 'admin/profile', 'Hồ sơ Admin', { user });
    } catch (error) {
        res.redirect('/home');
    }
});

// --- 3. QUẢN LÝ TUYẾN XE (Routes) ---
router.get('/routes', isAdmin, adminRouteController.getRoutesPage);
router.post('/routes/create', isAdmin, adminRouteController.createRoute);
router.post('/routes/:id/update', isAdmin, adminRouteController.updateRoute);
router.post('/routes/:id/deactivate', isAdmin, adminRouteController.deactivateRoute);
router.post('/routes/:id/activate', isAdmin, adminRouteController.activateRoute);

// --- 4. QUẢN LÝ TRẠM DỪNG (Stops) ---
router.get('/stops', isAdmin, adminStopController.getStopsPage);
router.post('/stops/create', isAdmin, adminStopController.createStop);
router.post('/stops/:id/update', isAdmin, adminStopController.updateStop);
router.post('/stops/:id/deactivate', isAdmin, adminStopController.deactivateStop);
router.post('/stops/:id/activate', isAdmin, adminStopController.activateStop);
// Quản lý hồ sơ ưu tiên (Priority Profile Management)
router.get('/priority-profiles', isAdmin, priorityController.listProfiles);
router.get('/priority-profiles/:profileId', isAdmin, priorityController.viewProfileDetail);
router.post('/priority-profiles/:profileId/approve', isAdmin, priorityController.approveProfile);
router.post('/priority-profiles/:profileId/reject', isAdmin, priorityController.rejectProfile);

// --- 5. ĐIỀU PHỐI LỊCH CHẠY (Schedules) ---
// Tạm thời để render view cho đến khi bạn có adminScheduleController
router.get('/schedules', isAdmin, (req, res) => renderAdmin(req, res, 'admin/schedules', 'Điều phối Lịch'));

// --- 6. QUẢN LÝ NHÂN SỰ (Staff) ---
router.get('/staff', isAdmin, adminController.getStaffList);
router.get('/staff/create', isAdmin, adminController.getCreateStaff);
router.post('/staff/create', isAdmin, adminController.createStaff);
router.post('/staff/:userId/toggle-lock', isAdmin, adminController.toggleLock);

// --- 7. QUẢN LÝ HỒ SƠ ƯU TIÊN (Priority Profiles) ---
router.get('/priority-profiles', isAdmin, adminController.getPriorityProfiles);
router.post('/priority-profiles/:userId/approve', isAdmin, adminController.approveProfile);
router.post('/priority-profiles/:userId/reject', isAdmin, adminController.rejectProfile);

module.exports = router;