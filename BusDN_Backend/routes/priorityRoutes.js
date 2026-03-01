const express = require('express');
const { priorityProfileUpload } = require('../config/multer');
const priorityController = require('../controllers/priorityController');
const { isAdmin } = require('../middleware/adminMiddleware');

// Middleware to check if user is logged in
const checkAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

module.exports = (priorityProfileUpload) => {
    const router = express.Router();

    // --- USER ROUTES ---
    // Registration form page
    router.get('/register', checkAuth, priorityController.getRegisterForm);

    // Submit registration (with file uploads)
    router.post('/register', 
        checkAuth,
        priorityProfileUpload.fields([
            { name: 'idCardFront', maxCount: 1 },
            { name: 'idCardBack', maxCount: 1 },
            { name: 'proofImage', maxCount: 1 }
        ]),
        priorityController.submitRegistration
    );

    // View status page
    router.get('/status', checkAuth, priorityController.getStatus);

    // View approved profile
    router.get('/view', checkAuth, priorityController.viewProfile);

    // --- ADMIN ROUTES ---
    // List all profiles (with status filter)
    router.get('/admin/profiles', isAdmin, priorityController.listProfiles);

    // View profile details
    router.get('/admin/profiles/:profileId', isAdmin, priorityController.viewProfileDetail);

    // Approve profile
    router.post('/admin/profiles/:profileId/approve', isAdmin, priorityController.approveProfile);

    // Reject profile
    router.post('/admin/profiles/:profileId/reject', isAdmin, priorityController.rejectProfile);

    return router;
};
