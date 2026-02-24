const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/adminMiddleware');
const { renderAdmin } = require('../middleware/renderAdmin');
const { User } = require('../models/models');
const adminController = require('../controllers/adminController');

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

// Quản lý hồ sơ ưu tiên
router.get('/priority-profiles', adminController.getPriorityProfiles);
router.post('/priority-profiles/:userId/approve', adminController.approveProfile); // Nút duyệt
router.post('/priority-profiles/:userId/reject', adminController.rejectProfile);   // Nút từ chối

module.exports = router;
