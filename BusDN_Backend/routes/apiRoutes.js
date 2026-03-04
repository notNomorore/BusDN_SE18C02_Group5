const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { User, Route, Stop } = require('../models/models');
const bcrypt = require('bcryptjs');

/**
 * API Routes for Mobile Clients (Expo/React Native)
 * All routes return JSON responses
 */

// ============================
// USER PROFILE ROUTES
// =================================

/**
 * GET /api/user/profile
 * Get current user profile
 * Auth: Required (JWT or Session)
 */
router.get('/user/profile', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-password');
        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        res.json({
            ok: true,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phone: user.phone,
                avatar: user.avatar,
                role: user.role,
                isVerified: user.isVerified,
                walletBalance: user.walletBalance || 0,
                priorityProfile: user.priorityProfile || {
                    status: 'NONE'
                }
            }
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/user/update-profile
 * Update user profile
 * Auth: Required
 * Body: { fullName, phone, avatar }
 */
router.post('/user/update-profile', authMiddleware, async (req, res) => {
    try {
        const { fullName, phone, avatar } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        if (fullName) user.fullName = fullName;
        if (phone) user.phone = phone;
        if (avatar) user.avatar = avatar;

        await user.save();

        res.json({
            ok: true,
            message: 'Cập nhật hồ sơ thành công',
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phone: user.phone,
                avatar: user.avatar
            }
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/user/change-password
 * Change user password
 * Auth: Required
 * Body: { oldPassword, newPassword }
 */
router.post('/user/change-password', authMiddleware, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ ok: false, message: 'Mật khẩu cũ không đúng' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({ ok: true, message: 'Cập nhật mật khẩu thành công' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// PRIORITY PROFILE ROUTES
// =================================

/**
 * POST /api/user/register-priority
 * Register for priority passenger (Student, Elderly, etc.)
 * Auth: Required
 * Body: { type, cardNumber, expiryDate, cardImageFront, cardImageBack }
 */
router.post('/user/register-priority', authMiddleware, async (req, res) => {
    try {
        const { type, cardNumber, expiryDate, cardImageFront, cardImageBack } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        user.priorityProfile = {
            type,
            cardNumber,
            expiryDate,
            cardImageFront,
            cardImageBack,
            status: 'PENDING'
        };

        await user.save();

        res.json({
            ok: true,
            message: 'Đơn đăng ký ưu tiên đang chờ xác nhận',
            priorityProfile: user.priorityProfile
        });
    } catch (error) {
        console.error('Error registering priority:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * GET /api/user/priority-status
 * Get current priority status
 * Auth: Required
 */
router.get('/user/priority-status', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('priorityProfile');
        
        res.json({
            ok: true,
            priorityProfile: user.priorityProfile || { status: 'NONE' }
        });
    } catch (error) {
        console.error('Error fetching priority status:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// =================================
// ROUTE & STOP INFORMATION
// ============================

/**
 * GET /api/routes
 * Get all bus routes
 * Auth: Optional (can be used by guests)
 * Query: ?search=keyword
 */
router.get('/routes', async (req, res) => {
    try {
        const { search } = req.query;
        let query = {};

        if (search) {
            query = {
                $or: [
                    { routeNumber: { $regex: search, $options: 'i' } },
                    { name: { $regex: search, $options: 'i' } }
                ]
            };
        }

        const routes = await Route.find(query)
            .populate('stops.stopId', 'name address lat lng')
            .limit(50);

        res.json({
            ok: true,
            routes: routes.map(route => ({
                id: route._id,
                routeNumber: route.routeNumber,
                name: route.name,
                distance: route.distance,
                operationTime: route.operationTime,
                stopsCount: route.stops?.length || 0
            }))
        });
    } catch (error) {
        console.error('Error fetching routes:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * GET /api/routes/:id
 * Get detailed route with all stops
 * Auth: Optional
 */
router.get('/routes/:id', async (req, res) => {
    try {
        const route = await Route.findById(req.params.id)
            .populate('stops.stopId', 'name address lat lng isTerminal');

        if (!route) {
            return res.status(404).json({ ok: false, message: 'Tuyến đường không tồn tại' });
        }

        // Format stops for display
        const formattedStops = (route.stops || []).map(stop => ({
            orderIndex: stop.orderIndex,
            stopId: stop.stopId?._id,
            name: stop.stopId?.name || 'N/A',
            address: stop.stopId?.address || '',
            lat: stop.stopId?.lat || 0,
            lng: stop.stopId?.lng || 0,
            isTerminal: stop.stopId?.isTerminal || false
        })).sort((a, b) => a.orderIndex - b.orderIndex);

        res.json({
            ok: true,
            route: {
                id: route._id,
                routeNumber: route.routeNumber,
                name: route.name,
                distance: route.distance,
                operationTime: route.operationTime,
                stops: formattedStops,
                schedules: route.schedules || []
            }
        });
    } catch (error) {
        console.error('Error fetching route detail:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * GET /api/stops
 * Get all bus stops
 * Auth: Optional
 * Query: ?search=keyword
 */
router.get('/stops', async (req, res) => {
    try {
        const { search } = req.query;
        let query = {};

        if (search) {
            query = {
                $or: [
                    { name: { $regex: search, $options: 'i' } },
                    { address: { $regex: search, $options: 'i' } }
                ]
            };
        }

        const stops = await Stop.find(query).limit(50);

        res.json({
            ok: true,
            stops: stops.map(stop => ({
                id: stop._id,
                name: stop.name,
                address: stop.address,
                lat: stop.lat,
                lng: stop.lng,
                isTerminal: stop.isTerminal
            }))
        });
    } catch (error) {
        console.error('Error fetching stops:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/routes/search
 * Search routes by origin and destination
 * Auth: Optional
 * Body: { origin, destination }
 */
router.post('/routes/search', async (req, res) => {
    try {
        const { origin, destination } = req.body;

        // Find stops matching origin/destination
        const originStops = await Stop.find({
            $or: [
                { name: { $regex: origin, $options: 'i' } },
                { address: { $regex: origin, $options: 'i' } }
            ]
        });

        const destStops = await Stop.find({
            $or: [
                { name: { $regex: destination, $options: 'i' } },
                { address: { $regex: destination, $options: 'i' } }
            ]
        });

        const originIds = originStops.map(s => s._id);
        const destIds = destStops.map(s => s._id);

        // Find routes containing both origin and destination stops
        const routes = await Route.find({
            'stops.stopId': {
                $all: [{ $elemMatch: { stopId: { $in: originIds } } }]
            }
        }).populate('stops.stopId', 'name address lat lng');

        // Filter routes that have both stops
        const matchingRoutes = routes.filter(route => {
            const stopIds = route.stops.map(s => s.stopId._id.toString());
            return originIds.some(id => stopIds.includes(id.toString())) &&
                   destIds.some(id => stopIds.includes(id.toString()));
        });

        res.json({
            ok: true,
            routes: matchingRoutes.map(route => ({
                id: route._id,
                routeNumber: route.routeNumber,
                name: route.name,
                distance: route.distance,
                stopsCount: route.stops?.length || 0
            }))
        });
    } catch (error) {
        console.error('Error searching routes:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// WALLET & BALANCE
// ============================

/**
 * GET /api/user/wallet
 * Get wallet balance
 * Auth: Required
 */
router.get('/user/wallet', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('walletBalance email');

        res.json({
            ok: true,
            walletBalance: user?.walletBalance || 0,
            email: user?.email
        });
    } catch (error) {
        console.error('Error fetching wallet:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/user/wallet/deposit
 * Deposit money to wallet (placeholder for payment gateway)
 * Auth: Required
 * Body: { amount }
 */
router.post('/user/wallet/deposit', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ ok: false, message: 'Số tiền không hợp lệ' });
        }

        // In real implementation, integrate with VNPAY or Stripe
        user.walletBalance = (user.walletBalance || 0) + amount;
        await user.save();

        res.json({
            ok: true,
            message: 'Nạp tiền thành công',
            newBalance: user.walletBalance
        });
    } catch (error) {
        console.error('Error depositing wallet:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// NOTIFICATIONS (Placeholder)
// ============================

/**
 * GET /api/notifications
 * Get user notifications
 * Auth: Required
 */
router.get('/notifications', authMiddleware, async (req, res) => {
    try {
        // Placeholder - implement notification system as needed
        res.json({
            ok: true,
            notifications: [] // Return empty array for now
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

module.exports = router;
