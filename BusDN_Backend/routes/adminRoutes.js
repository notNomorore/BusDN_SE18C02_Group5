const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/adminMiddleware');
const { renderAdmin } = require('../middleware/renderAdmin');
const { User, PriorityProfile } = require('../models/models');
const adminController = require('../controllers/adminController');
const priorityController = require('../controllers/priorityController');

// --- ADMIN API ROUTES (Handle operations) - Define specific routes first ---

// --- ADMIN VIEW ROUTES (Render pages) - Define general routes last ---
router.get('/dashboard', isAdmin, (req, res) => renderAdmin(req, res, 'admin/dashboard', 'Tổng quan'));
router.get('/routes', isAdmin, (req, res) => renderAdmin(req, res, 'admin/routes', 'Quản lý Tuyến'));
router.get('/schedules', isAdmin, (req, res) => renderAdmin(req, res, 'admin/schedules', 'Điều phối Lịch'));

router.get('/profile', isAdmin, async (req, res) => {
    const user = await User.findById(req.session.userId);
    renderAdmin(req, res, 'admin/profile', 'Hồ sơ Admin', { user });
});

// Quản lý nhân sự
router.get('/staff', adminController.getStaffList);
router.get('/staff/create', adminController.getCreateStaff);
router.post('/staff/create', adminController.createStaff);
router.post('/staff/:userId/toggle-lock', adminController.toggleLock); // Nút khóa/mở

// Quản lý hồ sơ ưu tiên (Priority Profile Management)
router.get('/priority-profiles', isAdmin, priorityController.listProfiles);
router.get('/priority-profiles/:profileId', isAdmin, priorityController.viewProfileDetail);
router.post('/priority-profiles/:profileId/approve', isAdmin, priorityController.approveProfile);
router.post('/priority-profiles/:profileId/reject', isAdmin, priorityController.rejectProfile);

module.exports = router;
