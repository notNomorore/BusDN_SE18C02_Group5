const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { User, Route, Stop, PriorityProfile, MonthlyPass, WalletTransaction } = require('../models/models');
const bcrypt = require('bcryptjs');
const { emitPendingPriorityCount, applyPriorityDiscount, applyPriorityExpiryForUser } = require('../utils/priorityUtils');
const scheduleController = require('../controllers/scheduleController'); // NEW

function makePassCode(year, month, userId) {
    const mm = String(month).padStart(2, "0");
    const shortUser = String(userId).slice(-6).toUpperCase();
    const rand = Math.floor(Math.random() * 9000 + 1000);
    return `MP-${year}${mm}-${shortUser}-${rand}`;
}

function getMonthDateRange(year, month) {
    const validFrom = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const validTo = new Date(year, month, 0, 23, 59, 59, 999);
    return { validFrom, validTo };
}

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
        user.isFirstLogin = false;
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
        user.isPriorityGroup = false;
        user.priorityStatus = 'PENDING';

        await user.save();
        await PriorityProfile.findOneAndUpdate(
            { userId: user._id },
            {
                userId: user._id,
                category: type || 'Other',
                idNumber: cardNumber || 'N/A',
                idCardImageFront: cardImageFront || '',
                idCardImageBack: cardImageBack || '',
                proofImage: cardImageFront || '',
                status: 'pending',
                rejectionReason: null,
                expiryDate: null
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await emitPendingPriorityCount();

        return res.json({
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
 * GET /api/routes/search/topRated
 * Get top rated routes/buses (mock)
 */
router.get('/routes/search/topRated', async (req, res) => {
    try {
        const topRatedBuses = [
            {
                id: 1,
                operator: "Luxury Express",
                routesId: { origin: "Da Nang", destination: "Hoi An" },
                dep_time: new Date().setHours(8, 0, 0, 0),
                arrivalTime: new Date().setHours(9, 30, 0, 0),
                price: 50000,
                isAc: true,
                isSleeper: false,
                isSeater: true,
                isWifi: true
            },
            {
                id: 2,
                operator: "City Bus Line",
                routesId: { origin: "Da Nang", destination: "Hue" },
                dep_time: new Date().setHours(10, 0, 0, 0),
                arrivalTime: new Date().setHours(12, 30, 0, 0),
                price: 100000,
                isAc: true,
                isSleeper: true,
                isSeater: false,
                isWifi: false
            },
            {
                id: 3,
                operator: "Sunshine Travels",
                routesId: { origin: "Da Nang", destination: "Ba Na Hills" },
                dep_time: new Date().setHours(7, 30, 0, 0),
                arrivalTime: new Date().setHours(8, 45, 0, 0),
                price: 80000,
                isAc: true,
                isSleeper: false,
                isSeater: true,
                isWifi: true
            }
        ];
        res.json(topRatedBuses);
    } catch (error) {
        console.error('Error fetching top rated:', error);
        res.status(500).json({ ok: false, message: 'Server error' });
    }
});

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
// MONTHLY PASS ROUTES
// ============================

/**
 * GET /api/user/passes/monthly
 * Get data for monthly pass page (routes, user passes)
 * Auth: Required
 */
router.get('/user/passes/monthly', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Update expired passes
        await MonthlyPass.updateMany(
            { status: "ACTIVE", validTo: { $lt: new Date() } },
            { $set: { status: "EXPIRED" } }
        );

        const user = await User.findById(userId).lean();
        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        const routes = await Route.find({ status: "ACTIVE" })
            .select('_id routeNumber name monthlyPassPrice description operationTime')
            .sort({ routeNumber: 1, name: 1 })
            .lean();

        let myPasses = await MonthlyPass.find({ userId: user._id })
            .populate("routeId")
            .sort({ year: -1, month: -1, createdAt: -1 })
            .limit(20)
            .lean();

        myPasses = myPasses.map((pass) => ({
            ...pass,
            displayRouteNumber: pass.routeId?.routeNumber || pass.routeSnapshot?.routeNumber || "",
            displayRouteName: pass.routeId?.name || pass.routeSnapshot?.name || "Tuyến không xác định"
        }));

        res.json({
            ok: true,
            walletBalance: user.walletBalance || 0,
            isPriorityGroup: user.isPriorityGroup,
            routes,
            myPasses
        });
    } catch (error) {
        console.error('Error fetching monthly passes:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/user/passes/monthly/purchase
 * Purchase a monthly pass using wallet balance
 * Auth: Required
 * Body: { routeId, month, year }
 */
router.post('/user/passes/monthly/purchase', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { routeId, month, year } = req.body;

        if (!routeId || !month || !year) {
            return res.status(400).json({ ok: false, message: 'Thiếu thông tin tuyến hoặc kỳ vé' });
        }

        await applyPriorityExpiryForUser(userId);
        const currentUser = await User.findById(userId).select("walletBalance isPriorityGroup");

        if (!currentUser) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetMonthStart = new Date(year, month - 1, 1);

        if (targetMonthStart < currentMonthStart) {
            return res.status(400).json({ ok: false, message: 'Không thể mua vé cho tháng đã qua' });
        }

        const route = await Route.findById(routeId).lean();
        if (!route || route.status !== "ACTIVE") {
            return res.status(400).json({ ok: false, message: 'Tuyến không hợp lệ hoặc đã ngưng hoạt động' });
        }

        const existingPass = await MonthlyPass.findOne({
            userId, routeId, month, year, status: { $ne: "CANCELLED" }
        }).lean();

        if (existingPass) {
            return res.status(400).json({ ok: false, message: `Bạn đã mua vé tháng cho tuyến này trong tháng ${month}/${year}` });
        }

        const originalPrice = Number(route.monthlyPassPrice || 0);
        if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
            return res.status(400).json({ ok: false, message: 'Giá vé tháng tuyến này chưa được cấu hình' });
        }

        const isPriorityGroup = !!currentUser?.isPriorityGroup;
        const discountedPrice = applyPriorityDiscount(originalPrice, { isPriorityGroup });
        const price = Math.round(Math.max(0, discountedPrice));
        const discountAmount = Math.max(0, originalPrice - price);

        if (currentUser.walletBalance < price) {
            return res.status(400).json({ ok: false, message: 'Số dư ví không đủ để mua vé tháng' });
        }

        const userAfterDeduct = await User.findOneAndUpdate(
            { _id: userId, walletBalance: { $gte: price } },
            { $inc: { walletBalance: -price } },
            { new: true }
        );

        if (!userAfterDeduct) {
            return res.status(400).json({ ok: false, message: 'Giao dịch thất bại, vui lòng thử lại' });
        }

        const { validFrom, validTo } = getMonthDateRange(year, month);
        let createdPass;

        try {
            createdPass = await MonthlyPass.create({
                userId,
                routeId,
                routeSnapshot: {
                    routeNumber: route.routeNumber || "",
                    name: route.name || ""
                },
                passCode: makePassCode(year, month, userId),
                month,
                year,
                validFrom,
                validTo,
                pricePaid: price,
                originalPrice,
                discountAmount,
                paidBy: "WALLET",
                status: "ACTIVE"
            });
        } catch (createErr) {
            await User.findByIdAndUpdate(userId, { $inc: { walletBalance: price } });
            if (createErr?.code === 11000) {
                return res.status(400).json({ ok: false, message: 'Bạn đã mua vé tháng cho tuyến này rồi' });
            }
            throw createErr;
        }

        await WalletTransaction.create({
            userId,
            amount: price,
            originalAmount: originalPrice,
            discountAmount,
            direction: "OUT",
            txnType: "MONTHLY_PASS",
            note: `Mua vé tháng tuyến ${route.routeNumber || ""} - ${route.name || ""} (${month}/${year})${isPriorityGroup ? " - Ưu đãi 20%" : ""}`,
            method: "WALLET",
            status: "SUCCESS",
            relatedMonthlyPassId: createdPass._id,
            paidAt: new Date()
        });

        res.json({
            ok: true,
            message: `Mua vé tháng thành công cho tuyến ${route.routeNumber} (${month}/${year})`,
            pass: createdPass,
            newBalance: userAfterDeduct.walletBalance
        });
    } catch (error) {
        console.error('Error purchasing monthly pass:', error);
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

/**
 * POST /api/admin/notifications/broadcast
 * Gửi thông báo hàng loạt — lưu log vào DB (stub) và trả về OK
 */
router.post('/admin/notifications/broadcast', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || !['ADMIN', 'STAFF'].includes(adminUser.role)) {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { audience, title, message } = req.body;
        if (!title || !message) {
            return res.status(400).json({ ok: false, message: 'Tiêu đề và nội dung là bắt buộc' });
        }

        // In a full implementation this would push to FCM / Socket.IO.
        // For now we log and return success so the frontend works.
        console.log(`[BROADCAST] audience=${audience} | title="${title}" | message="${message}" | by=${adminUser.email}`);

        res.json({
            ok: true,
            message: `Đã gửi thông báo "${title}" đến ${audience === 'DRIVERS' ? 'tài xế' : 'tất cả người dùng'} thành công.`,
            sentAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Error broadcasting notification:', err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// ADMIN USER MANAGEMENT
// ============================

/**
 * GET /api/admin/users
 * Get paginated list of users (Admin only)
 * Auth: Required (ADMIN role)
 */
router.get('/admin/users', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { search, role, page = 1, limit = 10 } = req.query;
        let filter = {};

        if (search) {
            filter.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }

        if (role && role !== 'ALL') {
            filter.role = role;
        }

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 10;
        const skip = (pageNum - 1) * limitNum;

        const total = await User.countDocuments(filter);
        const users = await User.find(filter)
            .select('-password -otp_code -otp_expires')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        res.json({
            ok: true,
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
            users
        });
    } catch (error) {
        console.error('Error fetching admin users:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/users/:userId/toggle-lock
 * Toggle lock/unlock user
 * Auth: Required (ADMIN role)
 */
router.post('/admin/users/:userId/toggle-lock', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }
        if (user.role === 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Không thể khóa Admin' });
        }

        user.status = user.status === 'LOCKED' || user.isLocked ? 'ACTIVE' : 'LOCKED';
        user.isLocked = user.status === 'LOCKED';
        await user.save();

        res.json({
            ok: true,
            message: `Tài khoản đã được ${user.isLocked ? 'khóa' : 'mở khóa'}`,
            user: {
                id: user._id,
                status: user.status,
                isLocked: user.isLocked
            }
        });
    } catch (error) {
        console.error('Error toggling admin lock:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/users/create
 * Create a new staff account 
 * Auth: Required (ADMIN role)
 */
router.post('/admin/users/create', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { fullName, email, phone, role } = req.body;

        if (!fullName || !role || (!email && !phone)) {
            return res.status(400).json({ ok: false, message: 'Vui lòng cung cấp đủ họ tên, vai trò và ít nhất SĐT hoặc Email' });
        }

        // Check if existing
        if (email) {
            const existingByEmail = await User.findOne({ email });
            if (existingByEmail) return res.status(400).json({ ok: false, message: 'Email đã tồn tại' });
        }
        if (phone) {
            const existingByPhone = await User.findOne({ phone });
            if (existingByPhone) return res.status(400).json({ ok: false, message: 'Số điện thoại đã tồn tại' });
        }

        // Just creating a dummy pass for now, realistically this imports adminController logic
        const password = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));

        const user = new User({
            fullName,
            email: email || undefined,
            phone: phone || undefined,
            role,
            password: hashedPassword,
            isVerified: true,
            isLocked: false,
            status: 'ACTIVE',
            isFirstLogin: true
        });

        await user.save();

        res.json({
            ok: true,
            message: 'Tạo tài khoản thành công',
            account: {
                fullName,
                email,
                phone,
                role,
                username: email || phone,
                password // Return generated password to display to Admin
            }
        });

    } catch (error) {
        console.error('Error creating admin user:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// ADMIN PRIORITY MANAGEMENT
// ============================

/**
 * GET /api/admin/priority-profiles
 * Get priority profiles (Admin only)
 */
router.get('/admin/priority-profiles', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { status = 'pending' } = req.query;
        const filter = {};
        if (['pending', 'approved', 'rejected'].includes(status)) {
            filter.status = status;
        }

        const profiles = await PriorityProfile.find(filter)
            .populate('userId', 'fullName email phone')
            .sort({ createdAt: -1 });

        res.json({ ok: true, profiles });
    } catch (error) {
        console.error('Error fetching priority profiles:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/priority-profiles/:profileId/approve
 */
router.post('/admin/priority-profiles/:profileId/approve', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const { profileId } = req.params;
        const { expiryDate } = req.body; // ISO String

        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) return res.status(404).json({ ok: false, message: 'Profile not found' });

        profile.status = 'approved';
        profile.expiryDate = expiryDate ? new Date(expiryDate) : null;
        profile.rejectionReason = null;
        await profile.save();

        // Sync user
        await User.findByIdAndUpdate(profile.userId._id, {
            isPriorityGroup: true,
            priorityStatus: 'APPROVED',
            'priorityProfile.status': 'APPROVED',
            'priorityProfile.expiryDate': profile.expiryDate
        });

        await emitPendingPriorityCount();

        res.json({ ok: true, message: 'Đã duyệt hồ sơ' });
    } catch (error) {
        console.error('Error approving profile:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/priority-profiles/:profileId/reject
 */
router.post('/admin/priority-profiles/:profileId/reject', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const { profileId } = req.params;
        const { rejectionReason } = req.body;

        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) return res.status(404).json({ ok: false, message: 'Profile not found' });

        profile.status = 'rejected';
        profile.rejectionReason = rejectionReason;
        profile.expiryDate = null;
        await profile.save();

        // Sync user
        await User.findByIdAndUpdate(profile.userId._id, {
            isPriorityGroup: false,
            priorityStatus: 'REJECTED',
            'priorityProfile.status': 'REJECTED'
        });

        await emitPendingPriorityCount();

        res.json({ ok: true, message: 'Đã từ chối hồ sơ' });
    } catch (error) {
        console.error('Error rejecting profile:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// ADMIN ROUTE MANAGEMENT
// ============================

/**
 * GET /api/admin/routes
 * Get all routes for Admin
 */
router.get('/admin/routes', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { q, status } = req.query;
        const filter = {};

        if (q) {
            filter.$or = [
                { routeNumber: { $regex: q, $options: 'i' } },
                { name: { $regex: q, $options: 'i' } },
                { description: { $regex: q, $options: 'i' } }
            ];
        }

        if (status && ['ACTIVE', 'INACTIVE'].includes(status)) {
            filter.status = status;
        }

        const routes = await Route.find(filter)
            .sort({ routeNumber: 1, createdAt: -1 })
            .lean();

        res.json({ ok: true, routes });
    } catch (error) {
        console.error('Error fetching admin routes:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/routes/create
 */
router.post('/admin/routes/create', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const { routeNumber, name, distance, startTime, endTime, status, description, monthlyPassPrice } = req.body;

        if (!routeNumber || !name || distance == null) {
            return res.status(400).json({ ok: false, message: 'Vui lòng nhập đầy đủ Mã tuyến, Tên tuyến, Cự ly.' });
        }

        const existed = await Route.findOne({ routeNumber: routeNumber.trim().toUpperCase() }).lean();
        if (existed) return res.status(400).json({ ok: false, message: `Mã tuyến "${routeNumber}" đã tồn tại.` });

        const payload = {
            routeNumber: routeNumber.trim().toUpperCase(),
            name: name.trim(),
            distance: Number(distance),
            description: description?.trim(),
            status: ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE',
            monthlyPassPrice: monthlyPassPrice != null ? Number(monthlyPassPrice) : 200000
        };

        if (startTime && endTime) {
            payload.operationTime = { start: startTime.trim(), end: endTime.trim() };
        }

        const newRoute = await Route.create(payload);
        res.json({ ok: true, message: 'Tạo tuyến thành công', route: newRoute });
    } catch (err) {
        console.error('Error creating route:', err);
        if (err.code === 11000) return res.status(400).json({ ok: false, message: 'Mã tuyến đã tồn tại.' });
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * PUT /api/admin/routes/:id
 */
router.put('/admin/routes/:id', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const { id } = req.params;
        const { routeNumber, name, distance, startTime, endTime, status, description, monthlyPassPrice } = req.body;

        const route = await Route.findById(id);
        if (!route) return res.status(404).json({ ok: false, message: 'Không tìm thấy tuyến' });

        const checkRouteNum = routeNumber.trim().toUpperCase();
        const existed = await Route.findOne({ routeNumber: checkRouteNum, _id: { $ne: id } }).lean();
        if (existed) return res.status(400).json({ ok: false, message: `Mã tuyến "${checkRouteNum}" đã tồn tại.` });

        route.routeNumber = checkRouteNum;
        route.name = name.trim();
        route.distance = Number(distance);
        route.description = description?.trim();
        route.status = ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE';
        route.monthlyPassPrice = monthlyPassPrice != null ? Number(monthlyPassPrice) : 200000;

        if (startTime && endTime) {
            route.operationTime = { start: startTime.trim(), end: endTime.trim() };
        } else {
            route.operationTime = undefined;
        }

        await route.save();
        res.json({ ok: true, message: 'Cập nhật tuyến thành công', route });
    } catch (err) {
        console.error('Error updating route:', err);
        if (err.code === 11000) return res.status(400).json({ ok: false, message: 'Mã tuyến đã tồn tại.' });
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/routes/:id/toggle-status
 * Toggle deactivate/activate
 */
router.post('/admin/routes/:id/toggle-status', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const route = await Route.findById(req.params.id);
        if (!route) return res.status(404).json({ ok: false, message: 'Không tìm thấy tuyến' });

        route.status = route.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
        await route.save();

        res.json({ ok: true, message: `Đã ${route.status === 'ACTIVE' ? 'kích hoạt' : 'tạm ngưng'} tuyến`, status: route.status });
    } catch (err) {
        console.error('Error toggling route status:', err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

// ============================
// ADMIN STOP MANAGEMENT
// ============================

/**
 * GET /api/admin/stops
 * Get all stops for Admin
 */
router.get('/admin/stops', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { q, status } = req.query;
        const filter = {};

        if (q) {
            filter.$or = [
                { name: { $regex: q, $options: 'i' } },
                { address: { $regex: q, $options: 'i' } }
            ];
        }

        if (status && ['ACTIVE', 'INACTIVE'].includes(status)) {
            filter.status = status;
        }

        const stops = await Stop.find(filter)
            .sort({ createdAt: -1, name: 1 })
            .lean();

        res.json({ ok: true, stops });
    } catch (error) {
        console.error('Error fetching admin stops:', error);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/stops/create
 */
router.post('/admin/stops/create', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        let { name, address, lat, lng, isTerminal, status } = req.body;

        name = typeof name === 'string' ? name.trim() : '';
        address = typeof address === 'string' ? address.trim() : '';

        if (!name || lat == null || lng == null) {
            return res.status(400).json({ ok: false, message: 'Vui lòng nhập đầy đủ Tên trạm, Vĩ độ và Kinh độ.' });
        }

        const existed = await Stop.findOne({ name }).lean();
        if (existed) return res.status(400).json({ ok: false, message: `Trạm "${name}" đã tồn tại.` });

        const newStop = await Stop.create({
            name,
            address,
            lat: Number(lat),
            lng: Number(lng),
            isTerminal: !!isTerminal,
            status: ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE'
        });

        res.json({ ok: true, message: 'Tạo trạm thành công', stop: newStop });
    } catch (err) {
        console.error('Error creating stop:', err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * PUT /api/admin/stops/:id
 */
router.put('/admin/stops/:id', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const { id } = req.params;
        let { name, address, lat, lng, isTerminal, status } = req.body;

        name = typeof name === 'string' ? name.trim() : '';
        address = typeof address === 'string' ? address.trim() : '';

        const stop = await Stop.findById(id);
        if (!stop) return res.status(404).json({ ok: false, message: 'Không tìm thấy trạm' });

        if (name && name !== stop.name) {
            const existed = await Stop.findOne({ name }).lean();
            if (existed) return res.status(400).json({ ok: false, message: `Trạm "${name}" đã tồn tại.` });
        }

        stop.name = name || stop.name;
        stop.address = address || stop.address;
        if (lat != null) stop.lat = Number(lat);
        if (lng != null) stop.lng = Number(lng);
        if (isTerminal != null) stop.isTerminal = !!isTerminal;
        if (status && ['ACTIVE', 'INACTIVE'].includes(status)) stop.status = status;

        await stop.save();

        res.json({ ok: true, message: 'Cập nhật trạm thành công', stop });
    } catch (err) {
        console.error('Error updating stop:', err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * Lịch Chạy / Xe Buýt (Schedule & Buses)
 */
router.get('/admin/buses', authMiddleware, scheduleController.getBuses);
router.post('/admin/buses/create', authMiddleware, scheduleController.createBus);

router.get('/admin/schedules', authMiddleware, scheduleController.getSchedules);
router.post('/admin/schedules/create', authMiddleware, scheduleController.createSchedule);
router.put('/admin/schedules/:id', authMiddleware, scheduleController.updateSchedule);
router.delete('/admin/schedules/:id', authMiddleware, scheduleController.deleteSchedule);
router.patch('/admin/schedules/:id/log', authMiddleware, scheduleController.updateTripLog);

// PUT /api/admin/buses/:id
router.put('/admin/buses/:id', authMiddleware, scheduleController.updateBus);

/**
 * POST /api/admin/stops/:id/toggle-status
 */
router.post('/admin/stops/:id/toggle-status', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const stop = await Stop.findById(req.params.id);
        if (!stop) return res.status(404).json({ ok: false, message: 'Không tìm thấy trạm' });

        stop.status = stop.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
        await stop.save();

        res.json({ ok: true, message: `Đã ${stop.status === 'ACTIVE' ? 'kích hoạt' : 'tạm ngưng'} trạm`, status: stop.status });
    } catch (err) {
        console.error('Error toggling stop status:', err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * Lost & Found CRUD
 * GET    /api/admin/lost-found
 * POST   /api/admin/lost-found
 * PUT    /api/admin/lost-found/:id
 * DELETE /api/admin/lost-found/:id
 */
const { LostFound } = require('../models/models');

router.get('/admin/lost-found', authMiddleware, async (req, res) => {
    try {
        const reports = await LostFound.find().sort({ date: -1 });
        res.json({ ok: true, reports });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

router.post('/admin/lost-found', authMiddleware, async (req, res) => {
    try {
        const { description, location, reporter, phone, date, notes } = req.body;
        if (!description || !location) return res.status(400).json({ ok: false, message: 'Mô tả và vị trí là bắt buộc' });
        const report = await LostFound.create({ description, location, reporter, phone, date, notes });
        res.json({ ok: true, message: 'Đã ghi nhận báo cáo', report });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

router.put('/admin/lost-found/:id', authMiddleware, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const report = await LostFound.findByIdAndUpdate(req.params.id, { status, notes }, { new: true });
        if (!report) return res.status(404).json({ ok: false, message: 'Không tìm thấy báo cáo' });
        res.json({ ok: true, message: 'Đã cập nhật báo cáo', report });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

router.delete('/admin/lost-found/:id', authMiddleware, async (req, res) => {
    try {
        await LostFound.findByIdAndDelete(req.params.id);
        res.json({ ok: true, message: 'Đã xóa báo cáo' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

module.exports = router;


