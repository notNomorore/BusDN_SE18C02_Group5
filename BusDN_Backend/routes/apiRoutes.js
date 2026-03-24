const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { User, Route, Stop, PriorityProfile, MonthlyPass, WalletTransaction, Schedule, Bus, LostFound, Notification, Feedback, TripTicket, Promotion } = require('../models/models');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const querystring = require('querystring');
const { emitPendingPriorityCount, applyPriorityExpiryForUser } = require('../utils/priorityUtils');
const scheduleController = require('../controllers/scheduleController'); // NEW
const { getIO } = require('../config/socket');
const {
    getFareMatrix,
    getPriorityDiscountPercentByCategory,
    resolveMonthlyPassBasePrice,
    estimateSingleRideFare,
    upsertFareMatrix,
    PASS_TYPE: FARE_PASS_TYPE
} = require('../services/fareMatrixService');

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

const PASS_TYPE = {
    SINGLE_ROUTE: 'SINGLE_ROUTE',
    INTER_ROUTE: 'INTER_ROUTE'
};

const normalizePromoCode = (value) => String(value || '').trim().toUpperCase();
const cleanText = (value) => (typeof value === 'string' ? value.trim() : '');
const PAYMENT_METHOD = {
    VNPAY: 'VNPAY',
    MOMO: 'MOMO'
};

async function getRouteDeactivationBlockers(routeId) {
    const activeSchedules = await Schedule.find({
        routeId,
        archived: { $ne: true },
        status: { $in: ['SCHEDULED', 'IN_PROGRESS'] }
    })
        .select('_id status trackingActive passengerCount')
        .lean();

    const scheduleIds = activeSchedules.map((schedule) => schedule._id);
    const runningSchedulesCount = activeSchedules.filter(
        (schedule) =>
            schedule.status === 'IN_PROGRESS' ||
            schedule.trackingActive === true ||
            Number(schedule.passengerCount || 0) > 0
    ).length;

    const activeTripTicketCount = scheduleIds.length
        ? await TripTicket.countDocuments({
            scheduleId: { $in: scheduleIds },
            status: { $in: ['BOOKED', 'USED'] }
        })
        : 0;

    return {
        activeSchedulesCount: activeSchedules.length,
        runningSchedulesCount,
        activeTripTicketCount
    };
}

async function validateRouteDeactivation(routeId) {
    const blockers = await getRouteDeactivationBlockers(routeId);

    if (blockers.runningSchedulesCount > 0) {
        return `Không thể tạm ngưng tuyến vì đang có ${blockers.runningSchedulesCount} chuyến đang chạy hoặc đang chở khách.`;
    }

    if (blockers.activeTripTicketCount > 0) {
        return `Không thể tạm ngưng tuyến vì còn ${blockers.activeTripTicketCount} vé lượt đã đặt/đang sử dụng trên các chuyến chưa hoàn tất.`;
    }

    if (blockers.activeSchedulesCount > 0) {
        return `Không thể tạm ngưng tuyến vì còn ${blockers.activeSchedulesCount} chuyến đã được lên lịch.`;
    }

    return null;
}

async function getStopDeactivationBlockers(stopId) {
    const protectedRouteStatuses = ['PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'SUSPENDED'];
    const relatedRoutes = await Route.find({
        status: { $in: protectedRouteStatuses },
        $or: [
            { startStopId: stopId },
            { endStopId: stopId },
            { 'stops.stopId': stopId },
            { 'directions.outbound.stops.stopId': stopId },
            { 'directions.inbound.stops.stopId': stopId }
        ]
    }).select('_id routeNumber name').lean();

    const relatedRouteIds = relatedRoutes.map((route) => route._id);
    const activeSchedulesCount = relatedRouteIds.length
        ? await Schedule.countDocuments({
            routeId: { $in: relatedRouteIds },
            archived: { $ne: true },
            status: { $in: ['SCHEDULED', 'IN_PROGRESS'] }
        })
        : 0;

    return { relatedRoutes, activeSchedulesCount };
}

async function validateStopDeactivation(stopId) {
    const blockers = await getStopDeactivationBlockers(stopId);
    if (!blockers.relatedRoutes.length && blockers.activeSchedulesCount === 0) return null;

    if (blockers.activeSchedulesCount > 0) {
        return `Không thể tạm ngưng trạm này vì còn ${blockers.activeSchedulesCount} lịch/chuyến đang dùng tuyến liên quan.`;
    }

    const routePreview = blockers.relatedRoutes
        .slice(0, 3)
        .map((route) => `${route.routeNumber} - ${route.name}`)
        .join(', ');
    const suffix = blockers.relatedRoutes.length > 3 ? '...' : '';
    return `Không thể tạm ngưng trạm này vì vẫn đang được dùng trong ${blockers.relatedRoutes.length} tuyến: ${routePreview}${suffix}`;
}

const ensureAdminApi = async (req, res) => {
    const adminUser = await User.findById(req.user.userId).select('role');
    if (!adminUser || adminUser.role !== 'ADMIN') {
        res.status(403).json({ ok: false, message: 'Forbidden' });
        return null;
    }
    return adminUser;
};

const ALLOWED_PROMOTION_STATUS = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED'];
const ALLOWED_PROMOTION_SCOPE = ['ALL', 'SINGLE_ROUTE', 'INTER_ROUTE'];
const ALLOWED_PROMOTION_DISCOUNT_TYPE = ['PERCENT', 'FIXED'];

const parseApiDateTime = (value) => {
    const raw = cleanText(value);
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseApiNumberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const toPromotionLifecycleStatus = (requestedStatus, startAt, endAt, now = new Date()) => {
    if (requestedStatus === 'DRAFT' || requestedStatus === 'CANCELLED' || requestedStatus === 'ENDED') {
        return requestedStatus;
    }
    if (endAt <= now) return 'ENDED';
    if (startAt > now) return 'SCHEDULED';
    return 'ACTIVE';
};

const mapPromotionPayloadFromApi = (body = {}) => {
    let routeId = cleanText(body.routeId);
    if (!routeId) routeId = null;

    return {
        code: cleanText(body.code).toUpperCase(),
        name: cleanText(body.name),
        description: cleanText(body.description),
        discountType: cleanText(body.discountType).toUpperCase() || 'PERCENT',
        discountValue: parseApiNumberOrNull(body.discountValue),
        maxDiscountValue: parseApiNumberOrNull(body.maxDiscountValue),
        minOrderValue: parseApiNumberOrNull(body.minOrderValue) ?? 0,
        applyScope: cleanText(body.applyScope).toUpperCase() || 'ALL',
        routeId,
        startAt: parseApiDateTime(body.startAt),
        endAt: parseApiDateTime(body.endAt),
        status: cleanText(body.status).toUpperCase() || 'DRAFT',
        usageLimitTotal: parseApiNumberOrNull(body.usageLimitTotal),
        usageLimitPerUser: parseApiNumberOrNull(body.usageLimitPerUser) ?? 1
    };
};

const parsePaymentMethod = (value) => (value === PAYMENT_METHOD.MOMO ? PAYMENT_METHOD.MOMO : PAYMENT_METHOD.VNPAY);

const buildBaseUrl = (req) => process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;

const toOrderCode = () => {
    const now = Date.now();
    const rnd = Math.floor(Math.random() * 1000);
    return Number(`${String(now).slice(-9)}${String(rnd).padStart(3, '0')}`);
};

const sortObject = (obj) => {
    const sorted = {};
    Object.keys(obj).sort().forEach((key) => {
        sorted[key] = obj[key];
    });
    return sorted;
};

const vnpEncode = (value) => encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/!/g, '%21')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/'/g, '%27');

const signVnpParams = (params, secret) => {
    const sorted = sortObject(params);
    const signData = querystring.stringify(sorted, '&', '=', {
        encodeURIComponent: vnpEncode
    });
    return crypto.createHmac('sha512', secret).update(signData, 'utf-8').digest('hex');
};

const buildVnpUrl = (baseUrl, params, secret) => {
    const sorted = sortObject(params);
    const secureHash = signVnpParams(sorted, secret);
    const query = querystring.stringify(sorted, '&', '=', {
        encodeURIComponent: vnpEncode
    });
    return `${baseUrl}?${query}&vnp_SecureHash=${secureHash}`;
};

const formatDateVnp = (date = new Date()) => {
    const vn = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const yyyy = vn.getFullYear();
    const MM = String(vn.getMonth() + 1).padStart(2, '0');
    const dd = String(vn.getDate()).padStart(2, '0');
    const HH = String(vn.getHours()).padStart(2, '0');
    const mm = String(vn.getMinutes()).padStart(2, '0');
    const ss = String(vn.getSeconds()).padStart(2, '0');
    return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
};

const addMinutesVnp = (date = new Date(), minutes = 15) => formatDateVnp(new Date(date.getTime() + minutes * 60 * 1000));

const getClientIp = (req) => {
    const rawIp = (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.connection?.remoteAddress
        || req.socket?.remoteAddress
        || req.ip
        || '127.0.0.1'
    );
    if (!rawIp || rawIp === '::1' || rawIp === '::') return '127.0.0.1';
    if (String(rawIp).startsWith('::ffff:')) return String(rawIp).replace('::ffff:', '');
    return String(rawIp);
};

const getVnpayBaseConfig = (req) => ({
    tmnCode: process.env.VNPAY_TMN_CODE || '',
    hashSecret: process.env.VNPAY_HASH_SECRET || '',
    vnpUrl: process.env.VNPAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    returnUrl: process.env.VNPAY_MONTHLY_RETURN_URL || `${buildBaseUrl(req)}/passenger/passes/monthly/vnpay-return`
});

const signMomoRaw = (rawSignature, accessKey, secretKey) => crypto.createHmac('sha256', secretKey).update(rawSignature).digest('hex');

const createMomoPayment = async (payload) => {
    const endpoint = process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create';
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const json = await response.json();
    if (!response.ok || Number(json?.resultCode) !== 0 || !json?.payUrl) {
        throw new Error(`Create MoMo link failed: ${JSON.stringify(json)}`);
    }
    return json;
};

const validatePromotionPayloadForApi = async (payload, mode = 'create') => {
    const errors = [];
    const now = new Date();

    if (!payload.code) errors.push('Mã khuyến mãi là bắt buộc.');
    if (!payload.name) errors.push('Tên chương trình là bắt buộc.');
    if (!ALLOWED_PROMOTION_DISCOUNT_TYPE.includes(payload.discountType)) {
        errors.push('Loại giảm giá không hợp lệ.');
    }
    if (!ALLOWED_PROMOTION_SCOPE.includes(payload.applyScope)) {
        errors.push('Phạm vi áp dụng không hợp lệ.');
    }
    if (!ALLOWED_PROMOTION_STATUS.includes(payload.status)) {
        errors.push('Trạng thái chương trình không hợp lệ.');
    }
    if (!payload.startAt || !payload.endAt) {
        errors.push('Thời gian bắt đầu và kết thúc là bắt buộc.');
    } else if (payload.endAt <= payload.startAt) {
        errors.push('Thời gian kết thúc phải lớn hơn thời gian bắt đầu.');
    }
    if (!Number.isFinite(payload.discountValue) || payload.discountValue <= 0) {
        errors.push('Giá trị giảm phải lớn hơn 0.');
    }
    if (payload.discountType === 'PERCENT' && payload.discountValue > 100) {
        errors.push('Giảm theo phần trăm không được vượt quá 100.');
    }
    if (payload.maxDiscountValue !== null && (!Number.isFinite(payload.maxDiscountValue) || payload.maxDiscountValue < 0)) {
        errors.push('Trần giảm tối đa không hợp lệ.');
    }
    if (!Number.isFinite(payload.minOrderValue) || payload.minOrderValue < 0) {
        errors.push('Giá trị đơn tối thiểu không hợp lệ.');
    }
    if (payload.usageLimitTotal !== null && (!Number.isInteger(payload.usageLimitTotal) || payload.usageLimitTotal < 1)) {
        errors.push('Giới hạn lượt dùng tổng phải là số nguyên dương.');
    }
    if (!Number.isInteger(payload.usageLimitPerUser) || payload.usageLimitPerUser < 1) {
        errors.push('Giới hạn lượt dùng mỗi người phải là số nguyên dương.');
    }

    if (payload.applyScope === 'SINGLE_ROUTE') {
        if (!payload.routeId) {
            errors.push('Phải chọn tuyến khi áp dụng cho vé đơn tuyến.');
        } else {
            const route = await Route.findOne({ _id: payload.routeId, status: 'ACTIVE' }).lean();
            if (!route) errors.push('Tuyến áp dụng không tồn tại hoặc không hoạt động.');
        }
    } else {
        payload.routeId = null;
    }

    if (mode === 'create' && (payload.status === 'ENDED' || payload.status === 'CANCELLED')) {
        errors.push('Không thể tạo mới với trạng thái ENDED/CANCELLED.');
    }

    return errors;
};

const calcPromotionDiscount = (orderAmount, promotion) => {
    const amount = Number(orderAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0 || !promotion) return 0;

    let discount = 0;
    if (promotion.discountType === 'PERCENT') {
        discount = Math.round((amount * Number(promotion.discountValue || 0)) / 100);
    } else {
        discount = Math.round(Number(promotion.discountValue || 0));
    }

    if (Number.isFinite(promotion.maxDiscountValue) && Number(promotion.maxDiscountValue) >= 0) {
        discount = Math.min(discount, Number(promotion.maxDiscountValue));
    }

    return Math.max(0, Math.min(discount, amount));
};

const getPriorityDiscountInfo = async (userId, fareMatrix) => {
    const fallback = { eligible: false, discountPercent: 0 };

    try {
        const now = new Date();
        const profile = await PriorityProfile.findOne({
            userId,
            status: { $in: ['approved', 'APPROVED'] },
            $or: [{ expiryDate: null }, { expiryDate: { $gte: now } }]
        })
            .sort({ updatedAt: -1, createdAt: -1 })
            .lean();

        if (profile) {
            return {
                eligible: true,
                discountPercent: getPriorityDiscountPercentByCategory(profile.category, fareMatrix)
            };
        }

        const user = await User.findById(userId).select('priorityProfile isPriorityGroup').lean();
        const legacyStatus = String(user?.priorityProfile?.status || '').toUpperCase();
        const legacyExpiry = user?.priorityProfile?.expiryDate ? new Date(user.priorityProfile.expiryDate) : null;
        const legacyActive = !legacyExpiry || legacyExpiry >= now;

        if (legacyStatus === 'APPROVED' && legacyActive) {
            return {
                eligible: true,
                discountPercent: getPriorityDiscountPercentByCategory('other', fareMatrix)
            };
        }

        if (user?.isPriorityGroup) {
            return { eligible: true, discountPercent: 20 };
        }

        return fallback;
    } catch (error) {
        return fallback;
    }
};

const validatePromotionForMonthlyPass = async ({
    promoCode,
    userId,
    passType,
    routeId,
    baseForPromo,
    now
}) => {
    if (!promoCode) {
        return { promotion: null, discountAmount: 0 };
    }

    const promotion = await Promotion.findOne({ code: promoCode }).lean();
    if (!promotion) throw new Error('MÃ£ giáº£m giÃ¡ khÃ´ng tá»“n táº¡i.');
    if (promotion.status !== 'ACTIVE') throw new Error('MÃ£ giáº£m giÃ¡ chÆ°a hoáº·c khÃ´ng cÃ²n hoáº¡t Ä‘á»™ng.');

    const startAt = promotion.startAt ? new Date(promotion.startAt) : null;
    const endAt = promotion.endAt ? new Date(promotion.endAt) : null;
    if (!startAt || !endAt || now < startAt || now > endAt) {
        throw new Error('MÃ£ giáº£m giÃ¡ Ä‘Ã£ háº¿t háº¡n hoáº·c chÆ°a Ä‘áº¿n thá»i gian Ã¡p dá»¥ng.');
    }

    if (promotion.minOrderValue && baseForPromo < Number(promotion.minOrderValue)) {
        throw new Error(`ÄÆ¡n hÃ ng chÆ°a Ä‘áº¡t giÃ¡ trá»‹ tá»‘i thiá»ƒu ${Number(promotion.minOrderValue).toLocaleString('vi-VN')} Ä‘.`);
    }

    if (promotion.applyScope === 'INTER_ROUTE' && passType !== PASS_TYPE.INTER_ROUTE) {
        throw new Error('Mã giảm giá chỉ áp dụng cho vé liên tuyến.');
    }

    if (promotion.applyScope === 'SINGLE_ROUTE') {
        if (passType !== PASS_TYPE.SINGLE_ROUTE) {
            throw new Error('Mã giảm giá chỉ áp dụng cho vé đơn tuyến.');
        }
        if (String(promotion.routeId || '') !== String(routeId || '')) {
            throw new Error('Mã giảm giá không áp dụng cho tuyến đã chọn.');
        }
    }

    if (promotion.usageLimitPerUser) {
        const usedByUser = await WalletTransaction.countDocuments({
            userId,
            txnType: 'MONTHLY_PASS',
            status: 'SUCCESS',
            'rawReturn.promotionId': String(promotion._id)
        });
        if (usedByUser >= Number(promotion.usageLimitPerUser)) {
            throw new Error('Báº¡n Ä‘Ã£ dÃ¹ng háº¿t lÆ°á»£t cá»§a mÃ£ giáº£m giÃ¡ nÃ y.');
        }
    }

    if (promotion.usageLimitTotal && Number(promotion.usageCount || 0) >= Number(promotion.usageLimitTotal)) {
        throw new Error('MÃ£ giáº£m giÃ¡ Ä‘Ã£ háº¿t lÆ°á»£t sá»­ dá»¥ng.');
    }

    const discountAmount = calcPromotionDiscount(baseForPromo, promotion);
    if (discountAmount <= 0) {
        throw new Error('MÃ£ giáº£m giÃ¡ khÃ´ng Ã¡p dá»¥ng cho Ä‘Æ¡n hÃ ng hiá»‡n táº¡i.');
    }

    return { promotion, discountAmount };
};

const consumePromotionUsage = async (promotionId) => {
    if (!promotionId) return;

    const promotion = await Promotion.findById(promotionId).lean();
    if (!promotion) throw new Error('MÃ£ giáº£m giÃ¡ khÃ´ng tá»“n táº¡i.');

    const filter = { _id: promotionId, status: 'ACTIVE' };
    if (promotion.usageLimitTotal) {
        filter.usageCount = { $lt: Number(promotion.usageLimitTotal) };
    }

    const updated = await Promotion.findOneAndUpdate(
        filter,
        { $inc: { usageCount: 1 } },
        { new: true }
    ).lean();

    if (!updated) {
        throw new Error('MÃ£ giáº£m giÃ¡ Ä‘Ã£ háº¿t lÆ°á»£t sá»­ dá»¥ng.');
    }
};

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
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }

        if (fullName) user.fullName = fullName;
        if (phone) user.phone = phone;
        if (avatar) user.avatar = avatar;

        await user.save();

        res.json({
            ok: true,
            message: 'Cáº­p nháº­t há»“ sÆ¡ thÃ nh cÃ´ng',
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        const { oldPassword, newPassword, isFirstLogin } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }

        // First-login flow: skip old password check
        if (!isFirstLogin) {
            if (!oldPassword) {
                return res.status(400).json({ ok: false, message: 'Vui lÃ²ng nháº­p máº­t kháº©u cÅ©' });
            }
            const isMatch = await bcrypt.compare(oldPassword, user.password);
            if (!isMatch) {
                return res.status(400).json({ ok: false, message: 'Máº­t kháº©u cÅ© khÃ´ng Ä‘Ãºng' });
            }
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.isFirstLogin = false;
        await user.save();

        res.json({ ok: true, message: 'Cáº­p nháº­t máº­t kháº©u thÃ nh cÃ´ng' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
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
            message: 'ÄÆ¡n Ä‘Äƒng kÃ½ Æ°u tiÃªn Ä‘ang chá» xÃ¡c nháº­n',
            priorityProfile: user.priorityProfile
        });
    } catch (error) {
        console.error('Error registering priority:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        let query = { status: 'ACTIVE' };

        if (search) {
            query = {
                status: 'ACTIVE',
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
                monthlyPassPrice: route.monthlyPassPrice,
                stopsCount: route.stops?.length || 0
            }))
        });
    } catch (error) {
        console.error('Error fetching routes:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(404).json({ ok: false, message: 'Tuyáº¿n Ä‘Æ°á»ng khÃ´ng tá»“n táº¡i' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * GET /api/schedules/for-booking?routeId=&date=YYYY-MM-DD
 * Danh sÃ¡ch chuyáº¿n cÃ³ thá»ƒ mua vÃ© láº» (khÃ´ng lÆ°u trá»¯, chÆ°a há»§y/káº¿t thÃºc)
 * Auth: Required
 */
router.get('/schedules/for-booking', authMiddleware, async (req, res) => {
    try {
        const { routeId, date } = req.query;
        if (!routeId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
            return res.status(400).json({ ok: false, message: 'Thiáº¿u routeId hoáº·c date (YYYY-MM-DD)' });
        }
        const dayStart = new Date(`${date}T00:00:00.000Z`);
        const dayEnd = new Date(`${date}T23:59:59.999Z`);
        if (Number.isNaN(dayStart.getTime())) {
            return res.status(400).json({ ok: false, message: 'NgÃ y khÃ´ng há»£p lá»‡' });
        }
        const { matrix: fareMatrix } = await getFareMatrix();
        const schedules = await Schedule.find({
            routeId,
            date: { $gte: dayStart, $lte: dayEnd },
            archived: { $ne: true },
            status: { $in: ['SCHEDULED', 'IN_PROGRESS'] }
        })
            .populate('routeId', 'routeNumber name monthlyPassPrice distance')
            .populate('busId', 'licensePlate capacity')
            .sort({ departureTime: 1, 'shiftTime.start': 1 })
            .lean();

        res.json({
            ok: true,
            schedules: schedules.map((s) => ({
                _id: s._id,
                date: s.date,
                departureTime: s.departureTime,
                shiftTime: s.shiftTime,
                status: s.status,
                routeId: s.routeId,
                busId: s.busId,
                estimatedFare: estimateSingleRideFare(Number(s.routeId?.distance || 0), fareMatrix)
            }))
        });
    } catch (error) {
        console.error('Error listing schedules for booking:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * GET /api/user/trip-tickets
 * VÃ© láº» cá»§a user (gáº§n Ä‘Ã¢y)
 * Auth: Required
 */
router.get('/user/trip-tickets', authMiddleware, async (req, res) => {
    try {
        const tickets = await TripTicket.find({ userId: req.user.userId })
            .populate('scheduleId', 'date departureTime shiftTime status')
            .populate('routeId', 'routeNumber name')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        res.json({ ok: true, tickets });
    } catch (error) {
        console.error('Error listing trip tickets:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ ok: false, message: 'Sá»‘ tiá»n khÃ´ng há»£p lá»‡' });
        }

        // In real implementation, integrate with VNPAY or Stripe
        user.walletBalance = (user.walletBalance || 0) + amount;
        await user.save();

        res.json({
            ok: true,
            message: 'Náº¡p tiá»n thÃ nh cÃ´ng',
            newBalance: user.walletBalance
        });
    } catch (error) {
        console.error('Error depositing wallet:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }

        const routes = await Route.find({ status: "ACTIVE" })
            .select('_id routeNumber name monthlyPassPrice description operationTime')
            .sort({ routeNumber: 1, name: 1 })
            .lean();
        const { matrix: fareMatrix } = await getFareMatrix();
        const priorityDiscount = await getPriorityDiscountInfo(userId, fareMatrix);
        const uiRoutes = routes.map((route) => ({
            ...route,
            effectiveMonthlyPassPrice: resolveMonthlyPassBasePrice(
                FARE_PASS_TYPE.SINGLE_ROUTE,
                Number(route.monthlyPassPrice || 0),
                fareMatrix
            )
        }));

        let myPasses = await MonthlyPass.find({ userId: user._id })
            .populate("routeId")
            .sort({ year: -1, month: -1, createdAt: -1 })
            .limit(20)
            .lean();

        myPasses = myPasses.map((pass) => ({
            ...pass,
            displayRouteNumber: pass.routeId?.routeNumber || pass.routeSnapshot?.routeNumber || "",
            displayRouteName: pass.routeId?.name || pass.routeSnapshot?.name || "Tuyáº¿n khÃ´ng xÃ¡c Ä‘á»‹nh"
        }));

        res.json({
            ok: true,
            walletBalance: user.walletBalance || 0,
            isPriorityGroup: user.isPriorityGroup,
            routes: uiRoutes,
            myPasses,
            interRouteMonthlyPrice: resolveMonthlyPassBasePrice(FARE_PASS_TYPE.INTER_ROUTE, 0, fareMatrix),
            priorityDiscountPercent: Number(priorityDiscount.discountPercent || 0),
            priorityDiscountEligible: !!priorityDiscount.eligible,
            freeRideRules: fareMatrix?.freeRideRules || null
        });
    } catch (error) {
        console.error('Error fetching monthly passes:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * GET /api/schedules/:scheduleId/seats
 * Danh sách ghế khả dụng cho một chuyến
 * Auth: Required
 */
router.get('/schedules/:scheduleId/seats', authMiddleware, async (req, res) => {
    try {
        const schedule = await Schedule.findById(req.params.scheduleId)
            .populate('busId', 'capacity licensePlate')
            .populate('routeId', 'routeNumber name')
            .lean();

        if (!schedule) {
            return res.status(404).json({ ok: false, message: 'Không tìm thấy chuyến xe.' });
        }

        if (['COMPLETED', 'CANCELLED'].includes(schedule.status)) {
            return res.status(400).json({ ok: false, message: 'Chuyến xe không còn mở bán vé.' });
        }

        const capacity = Math.max(1, Number(schedule.busId?.capacity || 45));
        const bookedTickets = await TripTicket.find({
            scheduleId: schedule._id,
            status: { $in: ['BOOKED', 'USED'] }
        }).select('seatLabel').lean();

        const bookedSet = new Set(bookedTickets.map((ticket) => String(ticket.seatLabel || '').trim().toUpperCase()));
        const seats = Array.from({ length: capacity }, (_, index) => {
            const seatLabel = String(index + 1).padStart(2, '0');
            return {
                seatLabel,
                status: bookedSet.has(seatLabel) ? 'BOOKED' : 'AVAILABLE'
            };
        });

        return res.json({
            ok: true,
            schedule: {
                _id: schedule._id,
                status: schedule.status,
                busId: schedule.busId,
                routeId: schedule.routeId
            },
            seats
        });
    } catch (error) {
        console.error('Error listing seats for schedule:', error);
        return res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

router.get('/user/passes/monthly/promo-preview', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const passType = String(req.query.passType || PASS_TYPE.SINGLE_ROUTE).trim() === PASS_TYPE.INTER_ROUTE ? PASS_TYPE.INTER_ROUTE : PASS_TYPE.SINGLE_ROUTE;
        const routeId = String(req.query.routeId || '').trim();
        const promoCode = normalizePromoCode(req.query.promoCode);

        let route = null;
        if (passType === PASS_TYPE.SINGLE_ROUTE) {
            if (!routeId) {
                return res.status(400).json({ ok: false, message: 'Vui lòng chọn tuyến trước khi áp mã.' });
            }

            route = await Route.findById(routeId).lean();
            if (!route || route.status !== 'ACTIVE') {
                return res.status(400).json({ ok: false, message: 'Tuyến không hợp lệ hoặc đã ngừng hoạt động.' });
            }
        }

        const { matrix: fareMatrix } = await getFareMatrix();
        const basePrice = resolveMonthlyPassBasePrice(
            passType,
            Number(route?.monthlyPassPrice || 0),
            fareMatrix
        );

        if (!Number.isFinite(basePrice) || basePrice <= 0) {
            return res.status(400).json({ ok: false, message: 'GiÃ¡ vÃ© thÃ¡ng chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh.' });
        }

        const priorityDiscount = await getPriorityDiscountInfo(userId, fareMatrix);
        const priorityDiscountAmount = Math.round((basePrice * Number(priorityDiscount.discountPercent || 0)) / 100);
        const priceAfterPriority = Math.max(0, basePrice - priorityDiscountAmount);

        if (!promoCode) {
            return res.json({
                ok: true,
                applied: false,
                message: 'ChÆ°a nháº­p mÃ£ giáº£m giÃ¡.',
                basePrice,
                discountPercent: Number(priorityDiscount.discountPercent || 0),
                priceAfterPriority,
                promoDiscountAmount: 0,
                finalPrice: priceAfterPriority
            });
        }

        const { promotion, discountAmount } = await validatePromotionForMonthlyPass({
            promoCode,
            userId,
            passType,
            routeId,
            baseForPromo: priceAfterPriority,
            now: new Date()
        });

        return res.json({
            ok: true,
            applied: true,
            message: `Ãp mÃ£ ${promotion.code} thÃ nh cÃ´ng, giáº£m ${discountAmount.toLocaleString('vi-VN')} Ä‘.`,
            promoCode: promotion.code,
            basePrice,
            discountPercent: Number(priorityDiscount.discountPercent || 0),
            priceAfterPriority,
            promoDiscountAmount: discountAmount,
            finalPrice: Math.max(0, priceAfterPriority - discountAmount)
        });
    } catch (error) {
        return res.status(400).json({
            ok: false,
            message: error?.message || 'KhÃ´ng thá»ƒ kiá»ƒm tra mÃ£ giáº£m giÃ¡.'
        });
    }
});

/**
 * POST /api/user/passes/monthly/checkout
 * JWT checkout, trả về paymentUrl để frontend tự redirect
 */
router.post('/user/passes/monthly/checkout', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const passType = req.body?.passType === PASS_TYPE.INTER_ROUTE ? PASS_TYPE.INTER_ROUTE : PASS_TYPE.SINGLE_ROUTE;
        const paymentMethod = parsePaymentMethod(req.body?.paymentMethod);
        const routeId = cleanText(req.body?.routeId);
        const month = Number(req.body?.month);
        const year = Number(req.body?.year);
        const promoCode = normalizePromoCode(req.body?.promoCode);

        if (passType === PASS_TYPE.SINGLE_ROUTE && !routeId) {
            return res.status(400).json({ ok: false, message: 'Vui lòng chọn tuyến.' });
        }
        if (!Number.isInteger(month) || month < 1 || month > 12) {
            return res.status(400).json({ ok: false, message: 'Tháng không hợp lệ.' });
        }
        if (!Number.isInteger(year) || year < 2000) {
            return res.status(400).json({ ok: false, message: 'Năm không hợp lệ.' });
        }

        await applyPriorityExpiryForUser(userId);
        const now = new Date();
        const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetMonth = new Date(year, month - 1, 1);
        if (targetMonth < currentMonth) {
            return res.status(400).json({ ok: false, message: 'Không thể mua vé tháng đã qua.' });
        }

        let route = null;
        if (passType === PASS_TYPE.SINGLE_ROUTE) {
            route = await Route.findById(routeId).lean();
            if (!route || route.status !== 'ACTIVE') {
                return res.status(400).json({ ok: false, message: 'Tuyến không hợp lệ.' });
            }
        }

        const duplicate = await MonthlyPass.findOne({
            userId,
            month,
            year,
            passType,
            routeId: passType === PASS_TYPE.SINGLE_ROUTE ? routeId : undefined,
            status: { $ne: 'CANCELLED' }
        }).lean();

        if (duplicate) {
            return res.status(400).json({ ok: false, message: 'Bạn đã mua vé rồi.' });
        }

        const { matrix: fareMatrix } = await getFareMatrix();
        const basePrice = resolveMonthlyPassBasePrice(
            passType,
            Number(route?.monthlyPassPrice || 0),
            fareMatrix
        );
        if (!basePrice || basePrice <= 0) {
            return res.status(400).json({ ok: false, message: 'Giá vé chưa cấu hình.' });
        }

        const priority = await getPriorityDiscountInfo(userId, fareMatrix);
        const priceAfterPriority = Math.max(0, basePrice - Math.round((basePrice * Number(priority.discountPercent || 0)) / 100));

        let promotion = null;
        let promoDiscount = 0;
        if (promoCode) {
            const promoResult = await validatePromotionForMonthlyPass({
                promoCode,
                userId,
                passType,
                routeId,
                baseForPromo: priceAfterPriority,
                now
            });
            promotion = promoResult.promotion;
            promoDiscount = promoResult.discountAmount;
        }

        const finalPrice = Math.max(1, priceAfterPriority - promoDiscount);
        const orderCode = toOrderCode();
        const txnRef = `${paymentMethod}-MP-${orderCode}`;

        await WalletTransaction.create({
            userId,
            amount: finalPrice,
            originalAmount: basePrice,
            discountAmount: basePrice - finalPrice,
            direction: 'OUT',
            txnType: 'MONTHLY_PASS',
            method: paymentMethod,
            status: 'PENDING',
            txnRef,
            rawReturn: {
                orderCode,
                passType,
                routeId,
                month,
                year,
                promoCode: promotion?.code || '',
                promotionId: promotion?._id || '',
                promoDiscount,
                promoReleased: false
            }
        });

        if (paymentMethod === PAYMENT_METHOD.VNPAY) {
            const { tmnCode, hashSecret, vnpUrl, returnUrl } = getVnpayBaseConfig(req);
            const vnpParams = {
                vnp_Version: '2.1.0',
                vnp_Command: 'pay',
                vnp_TmnCode: tmnCode,
                vnp_Locale: 'vn',
                vnp_CurrCode: 'VND',
                vnp_TxnRef: txnRef,
                vnp_OrderInfo: [
                    'Thanh toan ve thang',
                    passType === PASS_TYPE.INTER_ROUTE ? 'lien tuyen' : 'don tuyen',
                    `ky ${String(month).padStart(2, '0')}/${year}`,
                    txnRef
                ].join(' - '),
                vnp_OrderType: 'other',
                vnp_Amount: Math.round(finalPrice * 100),
                vnp_ReturnUrl: returnUrl,
                vnp_IpAddr: getClientIp(req),
                vnp_CreateDate: formatDateVnp(new Date()),
                vnp_ExpireDate: addMinutesVnp(new Date(), 15)
            };

            return res.json({
                ok: true,
                paymentMethod,
                paymentUrl: buildVnpUrl(vnpUrl, vnpParams, hashSecret)
            });
        }

        if (paymentMethod === PAYMENT_METHOD.MOMO) {
            const partnerCode = process.env.MOMO_PARTNER_CODE || '';
            const accessKey = process.env.MOMO_ACCESS_KEY || '';
            const secretKey = process.env.MOMO_SECRET_KEY || '';
            const redirectUrl = process.env.MOMO_MONTHLY_RETURN_URL || `${buildBaseUrl(req)}/passenger/passes/monthly/momo-return`;
            const ipnUrl = process.env.MOMO_MONTHLY_RETURN_URL || redirectUrl;
            const orderInfo = `Thanh toán vé tháng ${txnRef}`;
            const requestId = txnRef;
            const requestType = 'payWithMethod';
            const extraData = '';
            const autoCapture = true;
            const lang = 'vi';

            const rawSignature = [
                `accessKey=${accessKey}`,
                `amount=${finalPrice}`,
                `extraData=${extraData}`,
                `ipnUrl=${ipnUrl}`,
                `orderId=${txnRef}`,
                `orderInfo=${orderInfo}`,
                `partnerCode=${partnerCode}`,
                `redirectUrl=${redirectUrl}`,
                `requestId=${requestId}`,
                `requestType=${requestType}`
            ].join('&');

            const momo = await createMomoPayment({
                partnerCode,
                partnerName: process.env.MOMO_PARTNER_NAME || 'BusDN',
                storeId: process.env.MOMO_STORE_ID || 'BusDNStore',
                requestId,
                amount: String(finalPrice),
                orderId: txnRef,
                orderInfo,
                redirectUrl,
                ipnUrl,
                lang,
                requestType,
                autoCapture,
                extraData,
                signature: signMomoRaw(rawSignature, accessKey, secretKey)
            });

            return res.json({
                ok: true,
                paymentMethod,
                paymentUrl: momo.payUrl
            });
        }

        return res.status(400).json({ ok: false, message: 'Phương thức thanh toán không hợp lệ.' });
    } catch (error) {
        console.error('Error creating monthly pass checkout:', error);
        return res.status(500).json({ ok: false, message: error?.message || 'Không thể khởi tạo thanh toán.' });
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
        const promoCode = normalizePromoCode(req.body.promoCode);

        if (!routeId || !month || !year) {
            return res.status(400).json({ ok: false, message: 'Thiáº¿u thÃ´ng tin tuyáº¿n hoáº·c ká»³ vÃ©' });
        }

        await applyPriorityExpiryForUser(userId);
        const currentUser = await User.findById(userId).select("walletBalance isPriorityGroup priorityProfile");

        if (!currentUser) {
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetMonthStart = new Date(year, month - 1, 1);

        if (targetMonthStart < currentMonthStart) {
            return res.status(400).json({ ok: false, message: 'KhÃ´ng thá»ƒ mua vÃ© cho thÃ¡ng Ä‘Ã£ qua' });
        }

        const route = await Route.findById(routeId).lean();
        if (!route || route.status !== "ACTIVE") {
            return res.status(400).json({ ok: false, message: 'Tuyáº¿n khÃ´ng há»£p lá»‡ hoáº·c Ä‘Ã£ ngÆ°ng hoáº¡t Ä‘á»™ng' });
        }

        const existingPass = await MonthlyPass.findOne({
            userId, routeId, month, year, status: { $ne: "CANCELLED" }
        }).lean();

        if (existingPass) {
            return res.status(400).json({ ok: false, message: `Báº¡n Ä‘Ã£ mua vÃ© thÃ¡ng cho tuyáº¿n nÃ y trong thÃ¡ng ${month}/${year}` });
        }

        const { matrix: fareMatrix } = await getFareMatrix();
        const originalPrice = resolveMonthlyPassBasePrice(
            PASS_TYPE.SINGLE_ROUTE,
            Number(route.monthlyPassPrice || 0),
            fareMatrix
        );
        if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
            return res.status(400).json({ ok: false, message: 'GiÃ¡ vÃ© thÃ¡ng tuyáº¿n nÃ y chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh' });
        }

        const priorityDiscount = await getPriorityDiscountInfo(userId, fareMatrix);
        const priorityDiscountAmount = Math.round((originalPrice * Number(priorityDiscount.discountPercent || 0)) / 100);
        const priceAfterPriority = Math.max(0, originalPrice - priorityDiscountAmount);

        let promoDiscountAmount = 0;
        let promotion = null;
        if (promoCode) {
            const promoResult = await validatePromotionForMonthlyPass({
                promoCode,
                userId,
                passType: PASS_TYPE.SINGLE_ROUTE,
                routeId,
                baseForPromo: priceAfterPriority,
                now: new Date()
            });
            promoDiscountAmount = promoResult.discountAmount;
            promotion = promoResult.promotion;
        }

        const price = Math.max(0, priceAfterPriority - promoDiscountAmount);
        const discountAmount = Math.max(0, originalPrice - price);

        if (currentUser.walletBalance < price) {
            return res.status(400).json({ ok: false, message: 'Sá»‘ dÆ° vÃ­ khÃ´ng Ä‘á»§ Ä‘á»ƒ mua vÃ© thÃ¡ng' });
        }

        const userAfterDeduct = await User.findOneAndUpdate(
            { _id: userId, walletBalance: { $gte: price } },
            { $inc: { walletBalance: -price } },
            { new: true }
        );

        if (!userAfterDeduct) {
            return res.status(400).json({ ok: false, message: 'Giao dá»‹ch tháº¥t báº¡i, vui lÃ²ng thá»­ láº¡i' });
        }

        const { validFrom, validTo } = getMonthDateRange(year, month);
        let createdPass;

        try {
            if (promotion?._id) {
                await consumePromotionUsage(promotion._id);
            }

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
                return res.status(400).json({ ok: false, message: 'Báº¡n Ä‘Ã£ mua vÃ© thÃ¡ng cho tuyáº¿n nÃ y rá»“i' });
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
            note: `Mua vÃ© thÃ¡ng tuyáº¿n ${route.routeNumber || ""} - ${route.name || ""} (${month}/${year})`,
            method: "WALLET",
            status: "SUCCESS",
            relatedMonthlyPassId: createdPass._id,
            paidAt: new Date(),
            rawReturn: {
                promoCode: promotion?.code || '',
                promotionId: promotion?._id || '',
                promoDiscount: promoDiscountAmount
            }
        });

        res.json({
            ok: true,
            message: `Mua vÃ© thÃ¡ng thÃ nh cÃ´ng cho tuyáº¿n ${route.routeNumber} (${month}/${year})`,
            pass: createdPass,
            newBalance: userAfterDeduct.walletBalance
        });
    } catch (error) {
        console.error('Error purchasing monthly pass:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

// ============================
// NOTIFICATIONS (In-app + Socket.IO)
// ============================

const mapAudienceToRoles = (audience) => {
    if (audience === 'DRIVERS') return ['DRIVER', 'CONDUCTOR'];
    if (audience === 'CONDUCTORS') return ['CONDUCTOR'];
    return ['PASSENGER', 'DRIVER', 'CONDUCTOR', 'ADMIN'];
};

/**
 * GET /api/notifications
 * Get notifications for current user role
 * Auth: Required
 */
router.get('/notifications', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('role');
        if (!user) return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });

        const notifications = await Notification.find({ targetRoles: user.role })
            .sort({ sentAt: -1, createdAt: -1 })
            .limit(100)
            .lean();

        res.json({ ok: true, notifications });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/admin/notifications/broadcast
 * Gá»­i thÃ´ng bÃ¡o hÃ ng loáº¡t + lÆ°u DB + Ä‘áº©y realtime Socket.IO
 */
router.post('/admin/notifications/broadcast', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || !['ADMIN', 'STAFF'].includes(adminUser.role)) {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { audience = 'ALL', title, message } = req.body;
        if (!title || !message) {
            return res.status(400).json({ ok: false, message: 'TiÃªu Ä‘á» vÃ  ná»™i dung lÃ  báº¯t buá»™c' });
        }

        const targetRoles = mapAudienceToRoles(audience);

        const created = await Notification.create({
            title: String(title).trim(),
            message: String(message).trim(),
            audience,
            targetRoles,
            createdBy: adminUser._id,
            sentAt: new Date()
        });

        const io = getIO();
        if (io) {
            targetRoles.forEach((role) => {
                io.to(`role:${role}`).emit('notification:new', {
                    _id: created._id,
                    title: created.title,
                    message: created.message,
                    audience: created.audience,
                    targetRoles: created.targetRoles,
                    sentAt: created.sentAt
                });
            });
        }

        res.json({
            ok: true,
            message: `ÄÃ£ gá»­i thÃ´ng bÃ¡o "${created.title}" Ä‘áº¿n ${audience === 'DRIVERS' ? 'tÃ i xáº¿' : audience === 'CONDUCTORS' ? 'phá»¥ xe' : 'táº¥t cáº£ ngÆ°á»i dÃ¹ng'} thÃ nh cÃ´ng.`,
            sentAt: created.sentAt,
            notification: created
        });
    } catch (err) {
        console.error('Error broadcasting notification:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * GET /api/admin/fare-matrix
 * Auth: Required (ADMIN)
 */
router.get('/admin/fare-matrix', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const [{ matrix, source }, routes] = await Promise.all([
            getFareMatrix(),
            Route.find({ status: 'ACTIVE' }).sort({ routeNumber: 1 }).lean()
        ]);

        return res.json({
            ok: true,
            source,
            matrix,
            routes: routes.map((route) => ({
                _id: route._id,
                routeNumber: route.routeNumber,
                name: route.name,
                monthlyPassPrice: Number(route.monthlyPassPrice || 0),
                effectiveMonthlyPrice: resolveMonthlyPassBasePrice(
                    PASS_TYPE.SINGLE_ROUTE,
                    Number(route.monthlyPassPrice || 0),
                    matrix
                ),
                singleRideEstimatedFare: estimateSingleRideFare(Number(route.distance || 0), matrix)
            }))
        });
    } catch (err) {
        console.error('Error fetching fare matrix:', err);
        return res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * PUT /api/admin/fare-matrix
 * Auth: Required (ADMIN)
 */
router.put('/admin/fare-matrix', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const payload = {
            singleRide: {
                basePrice: Number(req.body?.singleRide?.basePrice || 0),
                distanceTiers: Array.isArray(req.body?.singleRide?.distanceTiers) ? req.body.singleRide.distanceTiers : []
            },
            monthly: {
                interRoutePrice: Number(req.body?.monthly?.interRoutePrice || 0),
                singleRouteDefaultPrice: Number(req.body?.monthly?.singleRouteDefaultPrice || 0)
            },
            priorityDiscounts: req.body?.priorityDiscounts || {},
            freeRideRules: req.body?.freeRideRules || {}
        };

        await upsertFareMatrix(payload, req.user.userId);
        const { matrix } = await getFareMatrix();

        return res.json({
            ok: true,
            message: 'Đã cập nhật bảng giá vé.',
            matrix
        });
    } catch (err) {
        console.error('Error updating fare matrix:', err);
        return res.status(400).json({ ok: false, message: err?.message || 'Không thể cập nhật bảng giá vé.' });
    }
});

/**
 * GET /api/admin/promotions
 * Auth: Required (ADMIN)
 */
router.get('/admin/promotions', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const q = cleanText(req.query.q);
        const status = cleanText(req.query.status).toUpperCase();
        const filter = {};

        if (q) {
            filter.$or = [
                { code: { $regex: q, $options: 'i' } },
                { name: { $regex: q, $options: 'i' } }
            ];
        }

        if (ALLOWED_PROMOTION_STATUS.includes(status)) {
            filter.status = status;
        }

        const [promotions, routes] = await Promise.all([
            Promotion.find(filter)
                .populate('routeId', 'routeNumber name status')
                .sort({ createdAt: -1 })
                .lean(),
            Route.find({ status: 'ACTIVE' }).sort({ routeNumber: 1 }).lean()
        ]);

        return res.json({ ok: true, promotions, routes });
    } catch (err) {
        console.error('Error fetching promotions:', err);
        return res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
});

/**
 * POST /api/admin/promotions
 * Auth: Required (ADMIN)
 */
router.post('/admin/promotions', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const payload = mapPromotionPayloadFromApi(req.body);
        const errors = await validatePromotionPayloadForApi(payload, 'create');
        if (errors.length) {
            return res.status(400).json({ ok: false, message: errors[0] });
        }

        const existed = await Promotion.findOne({ code: payload.code }).lean();
        if (existed) {
            return res.status(400).json({ ok: false, message: `Mã khuyến mãi "${payload.code}" đã tồn tại.` });
        }

        const lifecycleStatus = toPromotionLifecycleStatus(payload.status, payload.startAt, payload.endAt, new Date());
        const promotion = await Promotion.create({
            ...payload,
            status: lifecycleStatus,
            createdBy: req.user.userId,
            updatedBy: req.user.userId
        });

        return res.status(201).json({ ok: true, message: 'Đã tạo chương trình khuyến mãi.', promotion });
    } catch (err) {
        console.error('Error creating promotion:', err);
        return res.status(400).json({ ok: false, message: err?.message || 'Không thể tạo chương trình khuyến mãi.' });
    }
});

/**
 * PUT /api/admin/promotions/:id
 * Auth: Required (ADMIN)
 */
router.put('/admin/promotions/:id', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const promotion = await Promotion.findById(req.params.id);
        if (!promotion) {
            return res.status(404).json({ ok: false, message: 'Không tìm thấy chương trình cần cập nhật.' });
        }

        const payload = mapPromotionPayloadFromApi(req.body);
        const errors = await validatePromotionPayloadForApi(payload, 'update');
        if (errors.length) {
            return res.status(400).json({ ok: false, message: errors[0] });
        }

        const duplicate = await Promotion.findOne({ code: payload.code, _id: { $ne: req.params.id } }).lean();
        if (duplicate) {
            return res.status(400).json({ ok: false, message: `Mã khuyến mãi "${payload.code}" đã tồn tại.` });
        }

        const lifecycleStatus = toPromotionLifecycleStatus(payload.status, payload.startAt, payload.endAt, new Date());
        Object.assign(promotion, payload, {
            status: lifecycleStatus,
            updatedBy: req.user.userId
        });
        if (lifecycleStatus !== 'ENDED') {
            promotion.endedEarlyAt = null;
        }
        await promotion.save();

        return res.json({ ok: true, message: 'Đã cập nhật chương trình khuyến mãi.', promotion });
    } catch (err) {
        console.error('Error updating promotion:', err);
        return res.status(400).json({ ok: false, message: err?.message || 'Không thể cập nhật chương trình khuyến mãi.' });
    }
});

/**
 * POST /api/admin/promotions/:id/end-early
 * Auth: Required (ADMIN)
 */
router.post('/admin/promotions/:id/end-early', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const promotion = await Promotion.findById(req.params.id);
        if (!promotion) {
            return res.status(404).json({ ok: false, message: 'Không tìm thấy chương trình cần kết thúc sớm.' });
        }

        if (promotion.status === 'ENDED' || promotion.status === 'CANCELLED') {
            return res.status(400).json({ ok: false, message: 'Chương trình này đã kết thúc trước đó.' });
        }

        const now = new Date();
        promotion.status = 'ENDED';
        promotion.endAt = now;
        promotion.endedEarlyAt = now;
        promotion.updatedBy = req.user.userId;
        await promotion.save();

        return res.json({ ok: true, message: 'Đã kết thúc sớm chương trình.', promotion });
    } catch (err) {
        console.error('Error ending promotion early:', err);
        return res.status(400).json({ ok: false, message: err?.message || 'Không thể kết thúc chương trình.' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }
        if (user.role === 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'KhÃ´ng thá»ƒ khÃ³a Admin' });
        }

        user.status = user.status === 'LOCKED' || user.isLocked ? 'ACTIVE' : 'LOCKED';
        user.isLocked = user.status === 'LOCKED';
        await user.save();

        res.json({
            ok: true,
            message: `TÃ i khoáº£n Ä‘Ã£ Ä‘Æ°á»£c ${user.isLocked ? 'khÃ³a' : 'má»Ÿ khÃ³a'}`,
            user: {
                id: user._id,
                status: user.status,
                isLocked: user.isLocked
            }
        });
    } catch (error) {
        console.error('Error toggling admin lock:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(400).json({ ok: false, message: 'Vui lÃ²ng cung cáº¥p Ä‘á»§ há» tÃªn, vai trÃ² vÃ  Ã­t nháº¥t SÄT hoáº·c Email' });
        }

        // Check if existing
        if (email) {
            const existingByEmail = await User.findOne({ email });
            if (existingByEmail) return res.status(400).json({ ok: false, message: 'Email Ä‘Ã£ tá»“n táº¡i' });
        }
        if (phone) {
            const existingByPhone = await User.findOne({ phone });
            if (existingByPhone) return res.status(400).json({ ok: false, message: 'Sá»‘ Ä‘iá»‡n thoáº¡i Ä‘Ã£ tá»“n táº¡i' });
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
            message: 'Táº¡o tÃ i khoáº£n thÃ nh cÃ´ng',
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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

        res.json({ ok: true, message: 'ÄÃ£ duyá»‡t há»“ sÆ¡' });
    } catch (error) {
        console.error('Error approving profile:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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

        res.json({ ok: true, message: 'ÄÃ£ tá»« chá»‘i há»“ sÆ¡' });
    } catch (error) {
        console.error('Error rejecting profile:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/admin/routes/create
 */
router.post('/admin/routes/create', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const { routeNumber, name, distance, startTime, endTime, status, description, monthlyPassPrice, frequencyMinutes, roundTripMinutes, bufferMinutes } = req.body;

        if (!routeNumber || !name || distance == null) {
            return res.status(400).json({ ok: false, message: 'Vui lÃ²ng nháº­p Ä‘áº§y Ä‘á»§ MÃ£ tuyáº¿n, TÃªn tuyáº¿n, Cá»± ly.' });
        }

        const existed = await Route.findOne({ routeNumber: routeNumber.trim().toUpperCase() }).lean();
        if (existed) return res.status(400).json({ ok: false, message: `MÃ£ tuyáº¿n "${routeNumber}" Ä‘Ã£ tá»“n táº¡i.` });

        const payload = {
            routeNumber: routeNumber.trim().toUpperCase(),
            name: name.trim(),
            distance: Number(distance),
            description: description?.trim(),
            status: ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE',
            monthlyPassPrice: monthlyPassPrice != null ? Number(monthlyPassPrice) : 200000
        };

        if (frequencyMinutes != null) payload.frequencyMinutes = Math.max(1, Number(frequencyMinutes) || 15);
        if (roundTripMinutes != null) payload.roundTripMinutes = Math.max(1, Number(roundTripMinutes) || 60);
        if (bufferMinutes != null) payload.bufferMinutes = Math.max(0, Number(bufferMinutes) || 0);

        if (startTime && endTime) {
            payload.operationTime = { start: startTime.trim(), end: endTime.trim() };
        }

        const newRoute = await Route.create(payload);
        res.json({ ok: true, message: 'Táº¡o tuyáº¿n thÃ nh cÃ´ng', route: newRoute });
    } catch (err) {
        console.error('Error creating route:', err);
        if (err.code === 11000) return res.status(400).json({ ok: false, message: 'MÃ£ tuyáº¿n Ä‘Ã£ tá»“n táº¡i.' });
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        const { routeNumber, name, distance, startTime, endTime, status, description, monthlyPassPrice, frequencyMinutes, roundTripMinutes, bufferMinutes } = req.body;

        const route = await Route.findById(id);
        if (!route) return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y tuyáº¿n' });

        const checkRouteNum = routeNumber.trim().toUpperCase();
        const existed = await Route.findOne({ routeNumber: checkRouteNum, _id: { $ne: id } }).lean();
        if (existed) return res.status(400).json({ ok: false, message: `MÃ£ tuyáº¿n "${checkRouteNum}" Ä‘Ã£ tá»“n táº¡i.` });

        route.routeNumber = checkRouteNum;
        route.name = name.trim();
        route.distance = Number(distance);
        route.description = description?.trim();
        const nextStatus = ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE';
        if (nextStatus === 'INACTIVE' && route.status !== 'INACTIVE') {
            const deactivationError = await validateRouteDeactivation(route._id);
            if (deactivationError) {
                return res.status(409).json({ ok: false, message: deactivationError, code: 'ROUTE_DEACTIVATION_BLOCKED' });
            }
        }
        route.status = nextStatus;
        route.monthlyPassPrice = monthlyPassPrice != null ? Number(monthlyPassPrice) : 200000;

        if (frequencyMinutes != null) route.frequencyMinutes = Math.max(1, Number(frequencyMinutes) || 15);
        if (roundTripMinutes != null) route.roundTripMinutes = Math.max(1, Number(roundTripMinutes) || 60);
        if (bufferMinutes != null) route.bufferMinutes = Math.max(0, Number(bufferMinutes) || 0);

        if (startTime && endTime) {
            route.operationTime = { start: startTime.trim(), end: endTime.trim() };
        } else {
            route.operationTime = undefined;
        }

        await route.save();
        res.json({ ok: true, message: 'Cáº­p nháº­t tuyáº¿n thÃ nh cÃ´ng', route });
    } catch (err) {
        console.error('Error updating route:', err);
        if (err.code === 11000) return res.status(400).json({ ok: false, message: 'MÃ£ tuyáº¿n Ä‘Ã£ tá»“n táº¡i.' });
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        if (!route) return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y tuyáº¿n' });

        const nextStatus = route.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
        if (nextStatus === 'INACTIVE') {
            const deactivationError = await validateRouteDeactivation(route._id);
            if (deactivationError) {
                return res.status(409).json({ ok: false, message: deactivationError, code: 'ROUTE_DEACTIVATION_BLOCKED' });
            }
        }
        route.status = nextStatus;
        await route.save();

        res.json({ ok: true, message: `ÄÃ£ ${route.status === 'ACTIVE' ? 'kÃ­ch hoáº¡t' : 'táº¡m ngÆ°ng'} tuyáº¿n`, status: route.status });
    } catch (err) {
        console.error('Error toggling route status:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
            return res.status(400).json({ ok: false, message: 'Vui lÃ²ng nháº­p Ä‘áº§y Ä‘á»§ TÃªn tráº¡m, VÄ© Ä‘á»™ vÃ  Kinh Ä‘á»™.' });
        }

        const existed = await Stop.findOne({ name }).lean();
        if (existed) return res.status(400).json({ ok: false, message: `Tráº¡m "${name}" Ä‘Ã£ tá»“n táº¡i.` });

        const newStop = await Stop.create({
            name,
            address,
            lat: Number(lat),
            lng: Number(lng),
            isTerminal: !!isTerminal,
            status: ['ACTIVE', 'INACTIVE'].includes(status) ? status : 'ACTIVE'
        });

        res.json({ ok: true, message: 'Táº¡o tráº¡m thÃ nh cÃ´ng', stop: newStop });
    } catch (err) {
        console.error('Error creating stop:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
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
        if (!stop) return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y tráº¡m' });

        if (name && name !== stop.name) {
            const existed = await Stop.findOne({ name }).lean();
            if (existed) return res.status(400).json({ ok: false, message: `Tráº¡m "${name}" Ä‘Ã£ tá»“n táº¡i.` });
        }

        stop.name = name || stop.name;
        stop.address = address || stop.address;
        if (lat != null) stop.lat = Number(lat);
        if (lng != null) stop.lng = Number(lng);
        if (isTerminal != null) stop.isTerminal = !!isTerminal;
        if (status && ['ACTIVE', 'INACTIVE'].includes(status)) {
            if (status === 'INACTIVE' && stop.status !== 'INACTIVE') {
                const deactivationError = await validateStopDeactivation(stop._id);
                if (deactivationError) {
                    return res.status(409).json({ ok: false, message: deactivationError, code: 'STOP_DEACTIVATION_BLOCKED' });
                }
            }
            stop.status = status;
        }

        await stop.save();

        res.json({ ok: true, message: 'Cáº­p nháº­t tráº¡m thÃ nh cÃ´ng', stop });
    } catch (err) {
        console.error('Error updating stop:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * Lá»‹ch Cháº¡y / Xe BuÃ½t (Schedule & Buses)
 */
router.get('/admin/buses', authMiddleware, scheduleController.getBuses);
router.post('/admin/buses/create', authMiddleware, scheduleController.createBus);

router.get('/admin/schedules', authMiddleware, scheduleController.getSchedules);
router.post('/admin/schedules/generate', authMiddleware, scheduleController.generateSchedules);
router.get('/admin/schedules/:id/delete-impact', authMiddleware, scheduleController.getDeleteImpact);
router.post('/admin/schedules/:id/update-impact', authMiddleware, scheduleController.getUpdateImpact);
router.patch('/admin/schedules/:id/archive', authMiddleware, scheduleController.archiveSchedule);
router.post('/admin/schedules/create', authMiddleware, scheduleController.createSchedule);
router.put('/admin/schedules/:id', authMiddleware, scheduleController.updateSchedule);
router.delete('/admin/schedules/:id', authMiddleware, scheduleController.deleteSchedule);
router.patch('/admin/schedules/:id/log', authMiddleware, scheduleController.updateTripLog);
router.post('/driver/start-trip', authMiddleware, scheduleController.startTrip);
router.post('/driver/finish-trip', authMiddleware, scheduleController.finishTrip);
router.post('/driver/tracking/location', authMiddleware, scheduleController.updateTrackingLocation);
router.post('/driver/load-status', authMiddleware, scheduleController.updateLoadStatus);
router.post('/conductor/start-trip', authMiddleware, scheduleController.startTrip);

// PUT /api/admin/buses/:id
router.put('/admin/buses/:id', authMiddleware, scheduleController.updateBus);

/**
 * BÃ¡o cÃ¡o doanh thu (Revenue Reports)
 * GET /api/admin/reports/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|route
 */
router.get('/admin/reports/revenue', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId).select('role');
        if (!adminUser || !['ADMIN', 'STAFF'].includes(adminUser.role)) {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { from, to, group = 'day' } = req.query;
        const match = {};

        if (from || to) {
            match.date = {};
            if (from) {
                match.date.$gte = new Date(from);
            }
            if (to) {
                const end = new Date(to);
                end.setHours(23, 59, 59, 999);
                match.date.$lte = end;
            }
        }

        const schedules = await Schedule.find(match)
            .populate('routeId', 'routeNumber name')
            .lean();

        let totalRevenue = 0;
        let totalPassengers = 0;

        schedules.forEach((s) => {
            totalRevenue += Number(s.revenue || 0);
            totalPassengers += Number(s.passengerCount || 0);
        });

        const summary = {
            totalRevenue,
            totalPassengers,
            totalTrips: schedules.length,
        };

        const map = new Map();

        schedules.forEach((s) => {
            const revenue = Number(s.revenue || 0);
            const passengers = Number(s.passengerCount || 0);

            let key;
            let label;

            if (group === 'route') {
                key = String(s.routeId?._id || 'unknown');
                const routeNumber = s.routeId?.routeNumber || '?';
                const routeName = s.routeId?.name || 'Tuyáº¿n khÃ´ng xÃ¡c Ä‘á»‹nh';
                label = `Tuyáº¿n ${routeNumber} - ${routeName}`;
            } else {
                // group by day
                const d = s.date ? new Date(s.date) : null;
                const iso = d ? d.toISOString().substring(0, 10) : 'N/A';
                key = iso;
                label = d
                    ? d.toLocaleDateString('vi-VN', {
                        weekday: 'short',
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                    })
                    : 'KhÃ´ng rÃµ ngÃ y';
            }

            if (!map.has(key)) {
                map.set(key, {
                    key,
                    label,
                    revenue: 0,
                    passengers: 0,
                    trips: 0,
                });
            }
            const row = map.get(key);
            row.revenue += revenue;
            row.passengers += passengers;
            row.trips += 1;
        });

        const rows = Array.from(map.values()).sort((a, b) => {
            if (group === 'route') {
                return (a.label || '').localeCompare(b.label || '');
            }
            return (a.key || '').localeCompare(b.key || '');
        });

        res.json({ ok: true, summary, rows, groupBy: group });
    } catch (err) {
        console.error('Error building revenue report:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/admin/stops/:id/toggle-status
 */
router.post('/admin/stops/:id/toggle-status', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId);
        if (!adminUser || adminUser.role !== 'ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' });

        const stop = await Stop.findById(req.params.id);
        if (!stop) return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y tráº¡m' });

        const nextStatus = stop.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
        if (nextStatus === 'INACTIVE') {
            const deactivationError = await validateStopDeactivation(stop._id);
            if (deactivationError) {
                return res.status(409).json({ ok: false, message: deactivationError, code: 'STOP_DEACTIVATION_BLOCKED' });
            }
        }
        stop.status = nextStatus;
        await stop.save();

        res.json({ ok: true, message: `ÄÃ£ ${stop.status === 'ACTIVE' ? 'kÃ­ch hoáº¡t' : 'táº¡m ngÆ°ng'} tráº¡m`, status: stop.status });
    } catch (err) {
        console.error('Error toggling stop status:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * Lost & Found CRUD
 * GET    /api/admin/lost-found
 * POST   /api/admin/lost-found
 * PUT    /api/admin/lost-found/:id
 * DELETE /api/admin/lost-found/:id
 */


router.get('/admin/lost-found', authMiddleware, async (req, res) => {
    try {
        const reports = await LostFound.find().sort({ date: -1 });
        res.json({ ok: true, reports });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

router.post('/admin/lost-found', authMiddleware, async (req, res) => {
    try {
        const { description, location, reporter, phone, date, notes } = req.body;
        if (!description || !location) return res.status(400).json({ ok: false, message: 'MÃ´ táº£ vÃ  vá»‹ trÃ­ lÃ  báº¯t buá»™c' });
        const report = await LostFound.create({ description, location, reporter, phone, date, notes });
        res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n bÃ¡o cÃ¡o', report });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

// ============================
// FEEDBACK / COMPLAINTS
// ============================

/**
 * POST /api/feedback
 * HÃ nh khÃ¡ch gá»­i pháº£n há»“i / khiáº¿u náº¡i / Ä‘Ã¡nh giÃ¡
 * Auth: Optional (náº¿u Ä‘Ã£ Ä‘Äƒng nháº­p sáº½ gáº¯n userId)
 */
router.post('/feedback', authMiddleware, async (req, res) => {
    try {
        const { subject, message, rating, category } = req.body;

        if (!message || !String(message).trim()) {
            return res.status(400).json({ ok: false, message: 'Ná»™i dung pháº£n há»“i lÃ  báº¯t buá»™c' });
        }

        const user = await User.findById(req.user.userId).select('fullName email phone').lean();

        const doc = await Feedback.create({
            userId: user?._id || null,
            name: user?.fullName || '',
            email: user?.email || '',
            phone: user?.phone || '',
            subject: subject || '',
            message: message.trim(),
            rating: typeof rating === 'number' ? rating : null,
            category: category || 'COMPLAINT',
        });

        res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n pháº£n há»“i cá»§a báº¡n', feedback: doc });
    } catch (err) {
        console.error('Error creating feedback:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * GET /api/admin/feedback
 * Admin xem danh sÃ¡ch pháº£n há»“i khÃ¡ch hÃ ng
 * Query: status (optional)
 */
router.get('/admin/feedback', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId).select('role');
        if (!adminUser || !['ADMIN', 'STAFF'].includes(adminUser.role)) {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { status } = req.query;
        const filter = {};

        if (status && ['NEW', 'IN_PROGRESS', 'RESPONDED', 'CLOSED'].includes(status)) {
            filter.status = status;
        }

        const items = await Feedback.find(filter)
            .sort({ createdAt: -1 })
            .populate('userId', 'fullName email phone')
            .populate('repliedBy', 'fullName email')
            .lean();

        res.json({ ok: true, feedback: items });
    } catch (err) {
        console.error('Error fetching feedback for admin:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/admin/feedback/:id/reply
 * Admin tráº£ lá»i / cáº­p nháº­t tráº¡ng thÃ¡i pháº£n há»“i
 * Body: { replyText, status }
 */
router.post('/admin/feedback/:id/reply', authMiddleware, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user.userId).select('role');
        if (!adminUser || !['ADMIN', 'STAFF'].includes(adminUser.role)) {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { id } = req.params;
        const { replyText, status } = req.body;

        const update = {};
        if (replyText !== undefined) {
            update.adminReply = String(replyText || '').trim();
            update.repliedBy = adminUser._id;
            update.repliedAt = new Date();
        }

        if (status && ['NEW', 'IN_PROGRESS', 'RESPONDED', 'CLOSED'].includes(status)) {
            update.status = status;
        } else if (replyText !== undefined && !status) {
            // Náº¿u cÃ³ tráº£ lá»i nhÆ°ng khÃ´ng gá»­i status, máº·c Ä‘á»‹nh chuyá»ƒn sang RESPONDED
            update.status = 'RESPONDED';
        }

        const doc = await Feedback.findByIdAndUpdate(id, update, { new: true })
            .populate('userId', 'fullName email phone')
            .populate('repliedBy', 'fullName email')
            .lean();

        if (!doc) {
            return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y pháº£n há»“i' });
        }

        res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t pháº£n há»“i', feedback: doc });
    } catch (err) {
        console.error('Error replying feedback:', err);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

router.put('/admin/lost-found/:id', authMiddleware, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const report = await LostFound.findByIdAndUpdate(req.params.id, { status, notes }, { new: true });
        if (!report) return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y bÃ¡o cÃ¡o' });
        res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t bÃ¡o cÃ¡o', report });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

router.delete('/admin/lost-found/:id', authMiddleware, async (req, res) => {
    try {
        await LostFound.findByIdAndDelete(req.params.id);
        res.json({ ok: true, message: 'ÄÃ£ xÃ³a bÃ¡o cÃ¡o' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

// ============================
// DRIVER / CONDUCTOR PORTAL APIs
// ============================

/**
 * GET /api/driver/schedule
 * Returns schedules assigned to the logged-in DRIVER (by driverId)
 */
router.get('/driver/schedule', authMiddleware, async (req, res) => {
    try {
        const schedules = await Schedule.find({
            driverId: req.user.userId,
            archived: { $ne: true },
            status: { $nin: ['CANCELLED'] },
        })
            .populate('conductorId', 'fullName phone')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name')
            .sort({ date: -1 });
        res.json({ ok: true, schedules });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * GET /api/conductor/schedule
 * Returns schedules assigned to the logged-in CONDUCTOR (by conductorId)
 */
router.get('/conductor/schedule', authMiddleware, async (req, res) => {
    try {
        const schedules = await Schedule.find({
            conductorId: req.user.userId,
            archived: { $ne: true },
            status: { $nin: ['CANCELLED'] },
        })
            .populate('driverId', 'fullName phone')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name')
            .sort({ date: -1 });
        res.json({ ok: true, schedules });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/tickets/purchase
 * Mua vÃ© láº» theo chuyáº¿n (trá»« vÃ­)
 * Body: { scheduleId, seatLabel }
 */
router.post('/tickets/purchase', authMiddleware, async (req, res) => {
    try {
        const { scheduleId, seatLabel } = req.body;
        if (!scheduleId || !seatLabel) {
            return res.status(400).json({ ok: false, message: 'Thiáº¿u scheduleId hoáº·c sá»‘ gháº¿' });
        }
        const user = await User.findById(req.user.userId).select('walletBalance fullName');
        if (!user) return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        const schedule = await Schedule.findById(scheduleId).populate('routeId', 'routeNumber name monthlyPassPrice status');
        if (!schedule) return res.status(404).json({ ok: false, message: 'KhÃ´ng tÃ¬m tháº¥y chuyáº¿n xe' });
        if (['COMPLETED', 'CANCELLED'].includes(schedule.status)) {
            return res.status(400).json({ ok: false, message: 'Chuyáº¿n Ä‘Ã£ káº¿t thÃºc hoáº·c há»§y' });
        }
        const existedSeat = await TripTicket.findOne({
            scheduleId: schedule._id,
            seatLabel: String(seatLabel).trim().toUpperCase(),
            status: { $in: ['BOOKED', 'USED'] }
        }).lean();
        if (existedSeat) return res.status(400).json({ ok: false, message: 'Gháº¿ Ä‘Ã£ Ä‘Æ°á»£c Ä‘áº·t trong chuyáº¿n nÃ y' });

        const routePrice = Number(schedule.routeId?.monthlyPassPrice || 0);
        const ticketPrice = Math.max(5000, Math.round(routePrice > 0 ? routePrice / 30 : 7000));
        if ((user.walletBalance || 0) < ticketPrice) {
            return res.status(400).json({ ok: false, message: 'Sá»‘ dÆ° vÃ­ khÃ´ng Ä‘á»§ Ä‘á»ƒ mua vÃ© láº»' });
        }
        const userAfterDeduct = await User.findOneAndUpdate(
            { _id: user._id, walletBalance: { $gte: ticketPrice } },
            { $inc: { walletBalance: -ticketPrice } },
            { new: true }
        );
        if (!userAfterDeduct) return res.status(400).json({ ok: false, message: 'Giao dá»‹ch tháº¥t báº¡i, vui lÃ²ng thá»­ láº¡i' });

        const code = `TK-${schedule._id.toString().slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
        const ticket = await TripTicket.create({
            userId: user._id,
            scheduleId: schedule._id,
            routeId: schedule.routeId?._id || schedule.routeId,
            seatLabel: String(seatLabel).trim().toUpperCase(),
            pricePaid: ticketPrice,
            qrCode: code,
            status: 'BOOKED'
        });
        await WalletTransaction.create({
            userId: user._id,
            amount: ticketPrice,
            direction: 'OUT',
            txnType: 'TICKET',
            note: `VÃ© láº» chuyáº¿n ${schedule.routeId?.routeNumber || ''} - gháº¿ ${ticket.seatLabel}`,
            method: 'WALLET',
            status: 'SUCCESS'
        });
        return res.json({
            ok: true,
            message: 'Mua vÃ© láº» thÃ nh cÃ´ng',
            ticket,
            newBalance: userAfterDeduct.walletBalance
        });
    } catch (err) {
        console.error('Error purchasing ticket:', err);
        return res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/driver/incident
 * Driver submits an emergency incident report
 */
router.post('/driver/incident', authMiddleware, async (req, res) => {
    try {
        const { type, location, details, severity } = req.body;
        if (!location) return res.status(400).json({ ok: false, message: 'Vá»‹ trÃ­ lÃ  báº¯t buá»™c' });
        // Log to console (extend with Incident model if needed)
        console.log(`[INCIDENT] driver=${req.user.userId} type=${type} severity=${severity} loc="${location}" details="${details}"`);
        res.json({ ok: true, message: 'ÄÃ£ nháº­n bÃ¡o cÃ¡o sá»± cá»‘. Trung tÃ¢m sáº½ xá»­ lÃ½ ngay.' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/driver/confirm-handover
 * Driver confirms vehicle receipt at start of shift
 */
router.post('/driver/confirm-handover', authMiddleware, async (req, res) => {
    try {
        const { scheduleId } = req.body;
        console.log(`[HANDOVER] driver=${req.user.userId} schedule=${scheduleId} at=${new Date().toISOString()}`);
        res.json({ ok: true, message: 'ÄÃ£ xÃ¡c nháº­n nháº­n xe.' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

/**
 * POST /api/conductor/validate-qr
 * Conductor validates a passenger QR code (monthly pass or ticket)
 * Body: { code: string }
 */
router.post('/conductor/validate-qr', authMiddleware, async (req, res) => {
    try {
        const role = req.user?.role;
        if (!['CONDUCTOR', 'DRIVER', 'ADMIN', 'STAFF'].includes(role)) {
            return res.status(403).json({ ok: false, message: 'Chá»‰ tÃ i xáº¿, phá»¥ xe hoáº·c nhÃ¢n viÃªn má»›i quÃ©t Ä‘Æ°á»£c vÃ©' });
        }
        const { code } = req.body;
        if (!code) return res.status(400).json({ ok: false, message: 'MÃ£ QR khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });

        const token = code.trim();
        const looksLikeObjectId = /^[a-fA-F0-9]{24}$/.test(token);

        let pass = null;
        if (looksLikeObjectId) {
            pass = await MonthlyPass.findById(token)
                .populate('userId', 'fullName')
                .populate('routeId', 'routeNumber name');
        }
        if (!pass) {
            pass = await MonthlyPass.findOne({ passCode: token })
                .populate('userId', 'fullName')
                .populate('routeId', 'routeNumber name');
        }
        if (pass) {
            const now = new Date();
            if (pass.status && pass.status !== 'ACTIVE') {
                return res.json({ ok: false, message: `VÃ© thÃ¡ng khÃ´ng cÃ²n hiá»‡u lá»±c (${pass.status})` });
            }
            const validTo = pass.validTo || pass.endDate;
            if (validTo && new Date(validTo) < now) {
                return res.json({ ok: false, message: `VÃ© Ä‘Ã£ háº¿t háº¡n (${new Date(validTo).toLocaleDateString('vi-VN')})` });
            }
            const validFrom = pass.validFrom;
            if (validFrom && new Date(validFrom) > now) {
                return res.json({ ok: false, message: `VÃ© chÆ°a Ä‘áº¿n ngÃ y hiá»‡u lá»±c (${new Date(validFrom).toLocaleDateString('vi-VN')})` });
            }
            return res.json({
                ok: true,
                ticketType: 'MONTHLY_PASS',
                message: 'VÃ© thÃ¡ng há»£p lá»‡',
                passengerName: pass.userId?.fullName,
                routeNumber: pass.routeId?.routeNumber || pass.routeSnapshot?.routeNumber,
                validUntil: validTo ? new Date(validTo).toLocaleDateString('vi-VN') : 'KhÃ´ng giá»›i háº¡n',
                passCode: pass.passCode
            });
        }

        const ticket = await TripTicket.findOne({ qrCode: token })
            .populate('userId', 'fullName')
            .populate('routeId', 'routeNumber name')
            .populate('scheduleId', 'date departureTime shiftTime status');
        if (!ticket) {
            return res.json({ ok: false, message: 'MÃ£ vÃ© khÃ´ng tá»“n táº¡i hoáº·c khÃ´ng há»£p lá»‡' });
        }
        if (ticket.status === 'CANCELLED') return res.json({ ok: false, message: 'VÃ© Ä‘Ã£ bá»‹ há»§y' });
        if (ticket.status === 'USED') return res.json({ ok: false, message: 'VÃ© Ä‘Ã£ Ä‘Æ°á»£c sá»­ dá»¥ng' });

        ticket.status = 'USED';
        ticket.usedAt = new Date();
        await ticket.save();

        res.json({
            ok: true,
            ticketType: 'TRIP_TICKET',
            message: 'VÃ© láº» há»£p lá»‡',
            passengerName: ticket.userId?.fullName,
            routeNumber: ticket.routeId?.routeNumber,
            seatLabel: ticket.seatLabel,
            tripTime: ticket.scheduleId?.departureTime || ticket.scheduleId?.shiftTime?.start || 'N/A'
        });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

module.exports = router;



