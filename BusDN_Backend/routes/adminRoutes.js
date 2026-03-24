const express = require('express');
const router = express.Router();
const multer = require('multer');

const { isAdmin } = require('../middleware/adminMiddleware');
const { renderAdmin } = require('../middleware/renderAdmin');
const { User } = require('../models/models');

const adminController = require('../controllers/adminController');
const priorityController = require('../controllers/priorityController');
const adminRouteController = require('../controllers/adminRouteController');
const adminStopController = require('../controllers/adminStopController');  
const importUpload = multer({ storage: multer.memoryStorage() });
const adminPromotionController = require('../controllers/adminPromotionController');
const adminFareController = require('../controllers/adminFareController');
const adminReportController = require('../controllers/adminReportController');

// --- 2. TONG QUAN & HO SO ---
router.get('/dashboard', isAdmin, (req, res) => renderAdmin(req, res, 'admin/dashboard', 'Tổng quan'));
router.get('/profile', isAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        renderAdmin(req, res, 'admin/profile', 'Hồ sơ Admin', { user });
    } catch (error) { res.redirect('/home'); }
});

// --- 3. QUAN LY TUYEN XE ---
router.get('/routes/create', isAdmin, adminRouteController.getCreateRoutePage);
router.get('/routes', isAdmin, adminRouteController.getRoutesPage);
router.post('/routes/create', isAdmin, adminRouteController.createRoute);
router.post('/routes/:id/update', isAdmin, adminRouteController.updateRoute);
router.post('/routes/:id/deactivate', isAdmin, adminRouteController.deactivateRoute);
router.post('/routes/:id/activate', isAdmin, adminRouteController.activateRoute);

// --- 4. QUAN LY TRAM DUNG ---
router.get('/stops', isAdmin, adminStopController.getStopsPage);
router.post('/stops/create', isAdmin, adminStopController.createStop);
router.post('/stops/create-ajax', isAdmin, adminStopController.createStopAjax);
router.post('/stops/:id/update', isAdmin, adminStopController.updateStop);
router.post('/stops/:id/deactivate', isAdmin, adminStopController.deactivateStop);
router.post('/stops/:id/activate', isAdmin, adminStopController.activateStop);

// Quan ly ho so uu tien (flow moi)
router.get('/priority-profiles', isAdmin, priorityController.listProfiles);
router.get('/priority-profiles/:profileId', isAdmin, priorityController.viewProfileDetail);
router.post('/priority-profiles/:profileId/approve', isAdmin, priorityController.approveProfile);
router.post('/priority-profiles/:profileId/reject', isAdmin, priorityController.rejectProfile);

// NHÂN SỰ
router.get('/users', isAdmin, adminController.getStaffList);
// --- 5. DIEU PHOI LICH CHAY ---
router.get('/schedules', isAdmin, (req, res) => renderAdmin(req, res, 'admin/schedules', 'Điều phối lịch'));

// --- 6. MARKETING: PROMOTIONS ---
router.get('/promotions', isAdmin, adminPromotionController.getPromotionsPage);
router.post('/promotions/create', isAdmin, adminPromotionController.createPromotion);
router.post('/promotions/:id/update', isAdmin, adminPromotionController.updatePromotion);
router.post('/promotions/:id/end-early', isAdmin, adminPromotionController.endPromotionEarly);

// --- 6.1 FINANCE/ADMIN: FARE MATRIX ---
router.get('/fares', adminFareController.getFaresPage);
router.post('/fares/update', adminFareController.updateFares);

// --- 6.2 REPORTS ---
router.get('/reports', isAdmin, adminReportController.getReportsPage);
router.get('/reports/data', isAdmin, adminReportController.getRevenueReportData);

// --- 7. QUAN LY NHAN SU ---
router.get('/staff', isAdmin, adminController.getStaffList);
router.get('/staff/create', isAdmin, adminController.getCreateStaff);
router.post('/staff/create', isAdmin, adminController.createStaff);
router.post('/staff/import', isAdmin, importUpload.single('staffFile'), adminController.importStaff);
router.post('/staff/:userId/toggle-lock', isAdmin, adminController.toggleLock);

// --- 8. LEGACY PRIORITY ENDPOINTS (giu de tuong thich) ---
router.post('/priority-profiles/:userId/approve', isAdmin, adminController.approveProfile);
router.post('/priority-profiles/:userId/reject', isAdmin, adminController.rejectProfile);

module.exports = router;
