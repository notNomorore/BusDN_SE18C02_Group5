const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const multer = require('multer');
const { User, Route, Stop, PriorityProfile, MonthlyPass, WalletTransaction, Schedule, Bus, LostFound, Notification, Feedback, TripTicket, Promotion } = require('../models/models');
const { priorityProfileUpload } = require('../config/multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const querystring = require('querystring');
const { emitPendingPriorityCount, applyPriorityExpiryForUser } = require('../utils/priorityUtils');
const scheduleController = require('../controllers/scheduleController'); // NEW
const adminController = require('../controllers/adminController');
const { getIO } = require('../config/socket');
const { normalizeAvatarPath } = require('../utils/avatar');
const importUpload = multer({ storage: multer.memoryStorage() });
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
const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const QR_TOKEN_FIELDS = ['passCode', 'qrCode', 'ticketCode', 'code', 'passId', 'ticketId', 'token', 'id', '_id'];
const QR_TOKEN_NESTED_FIELDS = ['payload', 'data', 'value', 'ticket', 'pass'];

const extractQrToken = (payload, depth = 0) => {
    if (!payload || depth > 2) return '';
    if (typeof payload === 'string') return cleanText(payload);
    if (typeof payload !== 'object') return '';

    for (const field of QR_TOKEN_FIELDS) {
        const candidate = cleanText(payload[field]);
        if (candidate) return candidate;
    }

    for (const field of QR_TOKEN_NESTED_FIELDS) {
        const nestedToken = extractQrToken(payload[field], depth + 1);
        if (nestedToken) return nestedToken;
    }

    return '';
};

const resolveConductorQrToken = (code) => {
    if (code && typeof code === 'object') {
        const extractedFromObject = extractQrToken(code);
        if (extractedFromObject) return extractedFromObject;
    }

    const raw = cleanText(code);
    if (!raw) return '';

    try {
        const parsed = JSON.parse(raw);
        const extracted = extractQrToken(parsed);
        if (extracted) return extracted;
    } catch (_err) {
        // Plain text QR payloads fall back to the original value.
    }

    return raw;
};
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
const PROMO_RESERVATION_TTL_MINUTES = 20;

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
    if (endAt < now) return 'ENDED';
    if (startAt > now) return 'SCHEDULED';
    return 'ACTIVE';
};

const syncPromotionLifecycleStatuses = async (now = new Date()) => {
    const mutableFilter = { status: { $nin: ['DRAFT', 'CANCELLED', 'ENDED'] } };

    await Promise.all([
        Promotion.updateMany(
            {
                ...mutableFilter,
                endAt: { $lt: now }
            },
            { $set: { status: 'ENDED' } }
        ),
        Promotion.updateMany(
            {
                ...mutableFilter,
                startAt: { $gt: now },
                endAt: { $gte: now }
            },
            { $set: { status: 'SCHEDULED' } }
        ),
        Promotion.updateMany(
            {
                ...mutableFilter,
                startAt: { $lte: now },
                endAt: { $gte: now }
            },
            { $set: { status: 'ACTIVE' } }
        )
    ]);
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
const buildFrontendBaseUrl = () => (
    process.env.FRONTEND_URL
    || process.env.FRONTEND_BASE_URL
    || 'http://localhost:5173'
).replace(/\/$/, '');
const parsePositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const normalizeRouteId = (value) => {
    const routeId = cleanText(value);
    return routeId && mongoose.Types.ObjectId.isValid(routeId) ? routeId : '';
};
const buildRouteSnapshot = (route, fallback = {}) => ({
    routeId: normalizeRouteId(route?._id || fallback.routeId),
    routeNumber: cleanText(route?.routeNumber || fallback.routeNumber),
    name: cleanText(route?.name || fallback.name)
});
const buildFrontendUrl = (path, params = {}) => {
    const url = new URL(path, `${buildFrontendBaseUrl()}/`);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    return url.toString();
};

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
    returnUrl: process.env.VNPAY_MONTHLY_RETURN_URL
        || `${buildBaseUrl(req)}/api/user/passes/monthly/vnpay-return`
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

const verifyVnpChecksum = (queryObj, hashSecret) => {
    const cloned = { ...queryObj };
    const secureHash = cloned.vnp_SecureHash;
    delete cloned.vnp_SecureHash;
    delete cloned.vnp_SecureHashType;
    const calculated = signVnpParams(cloned, hashSecret);
    return String(calculated).toLowerCase() === String(secureHash || '').toLowerCase();
};

const getMonthlyPassMetaFromTransaction = (tx) => {
    const rawReturn = tx?.rawReturn && typeof tx.rawReturn === 'object' ? tx.rawReturn : {};
    const routeSnapshot = rawReturn?.routeSnapshot && typeof rawReturn.routeSnapshot === 'object'
        ? rawReturn.routeSnapshot
        : {};
    const routeId = normalizeRouteId(rawReturn.routeId || routeSnapshot.routeId);
    const passType = rawReturn.passType === PASS_TYPE.INTER_ROUTE
        ? PASS_TYPE.INTER_ROUTE
        : (rawReturn.passType === PASS_TYPE.SINGLE_ROUTE || routeId ? PASS_TYPE.SINGLE_ROUTE : PASS_TYPE.INTER_ROUTE);

    return {
        passType,
        routeId,
        month: parsePositiveInt(rawReturn.month),
        year: parsePositiveInt(rawReturn.year),
        promoCode: normalizePromoCode(rawReturn.promoCode),
        promotionId: cleanText(rawReturn.promotionId),
        routeSnapshot: buildRouteSnapshot(null, routeSnapshot)
    };
};

const mapMonthlyPassForClient = (pass) => {
    if (!pass) return null;
    return {
        ...pass,
        displayRouteNumber: pass.routeId?.routeNumber || pass.routeSnapshot?.routeNumber || '',
        displayRouteName: pass.routeId?.name || pass.routeSnapshot?.name || 'Tuyen khong xac dinh'
    };
};

const buildPassQrPayload = (pass) => String(pass.passCode || pass._id || '').trim();

const generateMonthlyPassQrBuffer = (pass) => QRCode.toBuffer(buildPassQrPayload(pass), {
    type: 'png',
    width: 220,
    margin: 2,
    errorCorrectionLevel: 'M'
});

const buildMonthlyPassPageRedirectFromTransaction = (tx, type, message) => {
    const meta = getMonthlyPassMetaFromTransaction(tx);
    return buildFrontendUrl('/monthly-pass', {
        [type]: message,
        txnRef: tx?.txnRef || '',
        paymentMethod: tx?.method || '',
        passType: meta.passType,
        routeId: meta.passType === PASS_TYPE.SINGLE_ROUTE ? meta.routeId : '',
        month: meta.month || '',
        year: meta.year || '',
        promoCode: meta.promoCode || ''
    });
};

const buildMonthlyPassResultRedirectFromTransaction = (tx, type, message, passId = '') => {
    const meta = getMonthlyPassMetaFromTransaction(tx);
    return buildFrontendUrl('/monthly-pass/result', {
        [type]: message,
        txnRef: tx?.txnRef || '',
        paymentMethod: tx?.method || '',
        passType: meta.passType,
        routeId: meta.passType === PASS_TYPE.SINGLE_ROUTE ? meta.routeId : '',
        month: meta.month || '',
        year: meta.year || '',
        amount: Number(tx?.amount || 0),
        passId: passId || tx?.relatedMonthlyPassId || ''
    });
};

const releasePromotionUsageSlot = async (promotionId) => {
    if (!promotionId) return;

    await Promotion.updateOne(
        { _id: promotionId, usageCount: { $gt: 0 } },
        { $inc: { usageCount: -1 } }
    );
};

const markPromotionReservationReleasedForTransaction = async (txId) => {
    if (!txId) return false;

    const tx = await WalletTransaction.findOneAndUpdate(
        {
            _id: txId,
            'rawReturn.promoReserved': true,
            'rawReturn.promotionId': { $exists: true, $ne: '' },
            'rawReturn.promoConsumed': { $ne: true },
            'rawReturn.promoReleased': { $ne: true }
        },
        {
            $set: {
                'rawReturn.promoReleased': true
            }
        },
        { new: false }
    ).lean();

    if (!tx?.rawReturn?.promotionId) {
        return false;
    }

    await releasePromotionUsageSlot(cleanText(tx.rawReturn.promotionId));
    return true;
};

const markPromotionReservationConsumedForTransaction = async (txId) => {
    if (!txId) return false;

    const result = await WalletTransaction.updateOne(
        {
            _id: txId,
            'rawReturn.promoReserved': true,
            'rawReturn.promotionId': { $exists: true, $ne: '' },
            'rawReturn.promoConsumed': { $ne: true },
            'rawReturn.promoReleased': { $ne: true }
        },
        {
            $set: {
                'rawReturn.promoConsumed': true
            }
        }
    );

    return result.modifiedCount > 0;
};

const releaseExpiredPromotionReservations = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() - (PROMO_RESERVATION_TTL_MINUTES * 60 * 1000));
    const expiredTxs = await WalletTransaction.find({
        txnType: 'MONTHLY_PASS',
        status: 'PENDING',
        createdAt: { $lte: cutoff },
        'rawReturn.promoReserved': true,
        'rawReturn.promotionId': { $exists: true, $ne: '' },
        'rawReturn.promoConsumed': { $ne: true },
        'rawReturn.promoReleased': { $ne: true }
    })
        .select('_id')
        .lean();

    for (const tx of expiredTxs) {
        const updated = await WalletTransaction.updateOne(
            {
                _id: tx._id,
                status: 'PENDING'
            },
            {
                $set: {
                    status: 'CANCELLED',
                    note: `Payment session expired after ${PROMO_RESERVATION_TTL_MINUTES} minutes.`
                }
            }
        );

        if (updated.modifiedCount > 0) {
            await markPromotionReservationReleasedForTransaction(tx._id);
        }
    }
};

const finalizePromotionUsageAfterSuccessfulPayment = async (tx) => {
    const promoId = cleanText(tx?.rawReturn?.promotionId);
    if (!promoId || tx?.rawReturn?.promoConsumed) return;

    if (tx?.rawReturn?.promoReserved) {
        await markPromotionReservationConsumedForTransaction(tx._id);
        return;
    }

    await consumePromotionUsage(promoId);
    await WalletTransaction.updateOne(
        {
            _id: tx._id,
            'rawReturn.promoConsumed': { $ne: true }
        },
        {
            $set: {
                'rawReturn.promoConsumed': true
            }
        }
    );
};

const markMonthlyPassTransactionFailed = async (tx, status, note, rawIpn = null, extraSet = {}) => {
    if (!tx?._id) return;
    const setPayload = {
        status,
        note,
        ...extraSet
    };
    if (rawIpn) {
        setPayload.rawIpn = rawIpn;
    }
    await WalletTransaction.updateOne(
        { _id: tx._id, status: 'PENDING' },
        { $set: setPayload }
    );
};

const createMonthlyPassFromTransaction = async (tx) => {
    const meta = getMonthlyPassMetaFromTransaction(tx);
    if (!meta.month || !meta.year) {
        throw new Error('Missing pass period in transaction metadata.');
    }
    if (meta.passType === PASS_TYPE.SINGLE_ROUTE && !meta.routeId) {
        throw new Error('Missing routeId for single-route monthly pass transaction.');
    }

    let route = null;
    if (meta.passType === PASS_TYPE.SINGLE_ROUTE) {
        route = await Route.findById(meta.routeId).lean();
        if (!route || route.status !== 'ACTIVE') {
            throw new Error('Route invalid or inactive.');
        }
    }

    const duplicateFilter = {
        userId: tx.userId,
        month: meta.month,
        year: meta.year,
        passType: meta.passType,
        status: { $ne: 'CANCELLED' }
    };
    if (meta.passType === PASS_TYPE.SINGLE_ROUTE) {
        duplicateFilter.routeId = meta.routeId;
    }

    const existingPass = await MonthlyPass.findOne(duplicateFilter).lean();
    if (existingPass) {
        return existingPass;
    }

    const { validFrom, validTo } = getMonthDateRange(meta.year, meta.month);
    const routeSnapshot = meta.passType === PASS_TYPE.SINGLE_ROUTE
        ? buildRouteSnapshot(route, meta.routeSnapshot)
        : buildRouteSnapshot(null, {
            routeNumber: meta.routeSnapshot.routeNumber || 'LT',
            name: meta.routeSnapshot.name || 'Ve lien tuyen'
        });

    return MonthlyPass.create({
        userId: tx.userId,
        passType: meta.passType,
        routeId: meta.passType === PASS_TYPE.SINGLE_ROUTE ? meta.routeId : null,
        routeSnapshot,
        passCode: makePassCode(meta.year, meta.month, tx.userId),
        month: meta.month,
        year: meta.year,
        validFrom,
        validTo,
        pricePaid: Number(tx.amount || 0),
        originalPrice: Number.isFinite(Number(tx.originalAmount)) ? Number(tx.originalAmount) : null,
        discountAmount: Number.isFinite(Number(tx.discountAmount)) ? Math.max(0, Number(tx.discountAmount)) : 0,
        paidBy: tx.method === PAYMENT_METHOD.MOMO ? 'MOMO' : 'VNPAY',
        status: 'ACTIVE'
    });
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

const normalizePriorityProfileStatus = (status) => {
    const value = String(status || '').trim().toUpperCase();
    if (['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'NONE'].includes(value)) {
        return value;
    }
    return 'NONE';
};

const mapPriorityProfileForApi = (user, profile) => {
    const userPriority = user?.priorityProfile || {};

    return {
        type: String(userPriority.type || profile?.category || '').trim(),
        cardNumber: String(userPriority.cardNumber || profile?.idNumber || '').trim(),
        cardImageFront: String(userPriority.cardImageFront || profile?.idCardImageFront || '').trim(),
        cardImageBack: String(userPriority.cardImageBack || profile?.idCardImageBack || '').trim(),
        proofImage: String(userPriority.proofImage || profile?.proofImage || '').trim(),
        rejectionReason: String(profile?.rejectionReason || userPriority.rejectionReason || '').trim(),
        expiryDate: userPriority.expiryDate || profile?.expiryDate || null,
        status: normalizePriorityProfileStatus(user?.priorityStatus || userPriority.status || profile?.status || 'NONE')
    };
};

const getLatestPriorityProfileForUser = async (userId) => {
    if (!userId) return null;
    return PriorityProfile.findOne({ userId })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();
};

const resolvePriorityFilePath = (files, fieldName, fallbackValue = '') => {
    const uploadedFileName = files?.[fieldName]?.[0]?.filename;
    if (uploadedFileName) {
        return `/uploads/priority/${uploadedFileName}`;
    }
    return String(fallbackValue || '').trim();
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

    await syncPromotionLifecycleStatuses(now);

    const promotion = await Promotion.findOne({ code: promoCode }).lean();
    if (!promotion) throw new Error('Mã giảm giá không tồn tại.');
    if (promotion.status !== 'ACTIVE') throw new Error('Mã giảm giá chưa hoặc không còn hoạt động.');

    const startAt = promotion.startAt ? new Date(promotion.startAt) : null;
    const endAt = promotion.endAt ? new Date(promotion.endAt) : null;
    if (!startAt || !endAt || now < startAt || now > endAt) {
        throw new Error('Mã giảm giá đã hết hạn hoặc chưa đến thời gian áp dụng.');
    }

    if (promotion.minOrderValue && baseForPromo < Number(promotion.minOrderValue)) {
        throw new Error(`Đơn hàng chưa đạt giá trị tối thiểu ${Number(promotion.minOrderValue).toLocaleString('vi-VN')} đ.`);
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
            status: { $in: ['PENDING', 'SUCCESS'] },
            'rawReturn.promotionId': String(promotion._id)
        });
        if (usedByUser >= Number(promotion.usageLimitPerUser)) {
            throw new Error('Bạn đã dùng hết lượt của mã giảm giá này.');
        }
    }

    if (promotion.usageLimitTotal && Number(promotion.usageCount || 0) >= Number(promotion.usageLimitTotal)) {
        throw new Error('Mã giảm giá đã hết lượt sử dụng.');
    }

    const discountAmount = calcPromotionDiscount(baseForPromo, promotion);
    if (discountAmount <= 0) {
        throw new Error('Mã giảm giá không áp dụng cho đơn hàng hiện tại.');
    }

    return { promotion, discountAmount };
};

const reservePromotionForMonthlyPass = async ({
    promoCode,
    userId,
    passType,
    routeId,
    baseForPromo,
    now
}) => {
    const validated = await validatePromotionForMonthlyPass({
        promoCode,
        userId,
        passType,
        routeId,
        baseForPromo,
        now
    });

    if (!validated.promotion) {
        return validated;
    }

    const reserveFilter = {
        _id: validated.promotion._id,
        status: 'ACTIVE',
        startAt: { $lte: now },
        endAt: { $gte: now }
    };

    if (validated.promotion.usageLimitTotal) {
        reserveFilter.usageCount = { $lt: Number(validated.promotion.usageLimitTotal) };
    }

    const reservedPromotion = await Promotion.findOneAndUpdate(
        reserveFilter,
        { $inc: { usageCount: 1 } },
        { new: true }
    ).lean();

    if (!reservedPromotion) {
        throw new Error('Mã giảm giá đã hết lượt sử dụng.');
    }

    const discountAmount = calcPromotionDiscount(baseForPromo, reservedPromotion);
    if (discountAmount <= 0) {
        await releasePromotionUsageSlot(reservedPromotion._id);
        throw new Error('Mã giảm giá không áp dụng cho đơn hàng hiện tại.');
    }

    return { promotion: reservedPromotion, discountAmount };
};

const consumePromotionUsage = async (promotionId) => {
    if (!promotionId) return;

    await syncPromotionLifecycleStatuses(new Date());

    const promotion = await Promotion.findById(promotionId).lean();
    if (!promotion) throw new Error('Mã giảm giá không tồn tại.');

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
        throw new Error('Mã giảm giá đã hết lượt sử dụng.');
    }
};

const buildPromotionUsageHistoryFilter = async ({
    promotionId = '',
    q = '',
    status = 'SUCCESS'
}) => {
    const filter = {
        txnType: 'MONTHLY_PASS'
    };
    const conditions = [
        {
            $or: [
                { 'rawReturn.promotionId': { $exists: true, $ne: '' } },
                { 'rawReturn.promoCode': { $exists: true, $ne: '' } }
            ]
        }
    ];

    const normalizedPromotionId = cleanText(promotionId);
    if (normalizedPromotionId) {
        if (!mongoose.Types.ObjectId.isValid(normalizedPromotionId)) {
            const error = new Error('Mã khuyến mãi không hợp lệ.');
            error.statusCode = 400;
            throw error;
        }
        const promotion = await Promotion.findById(normalizedPromotionId).select('code').lean();
        const normalizedPromotionCode = normalizePromoCode(promotion?.code || '');
        conditions.push({
            $or: [
                { 'rawReturn.promotionId': normalizedPromotionId },
                ...(normalizedPromotionCode ? [{ 'rawReturn.promoCode': normalizedPromotionCode }] : [])
            ]
        });
    }

    const normalizedStatus = cleanText(status).toUpperCase();
    if (!normalizedStatus || normalizedStatus === 'SUCCESS') {
        filter.status = 'SUCCESS';
    } else if (normalizedStatus !== 'ALL') {
        const allowedStatus = ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'];
        if (allowedStatus.includes(normalizedStatus)) {
            filter.status = normalizedStatus;
        } else {
            filter.status = 'SUCCESS';
        }
    }

    const keyword = cleanText(q);
    if (keyword) {
        const regex = new RegExp(escapeRegExp(keyword), 'i');
        const matchedUserIds = await User.distinct('_id', {
            $or: [
                { fullName: regex },
                { email: regex },
                { phone: regex }
            ]
        });
        const matchedPassIds = await MonthlyPass.distinct('_id', {
            $or: [
                { passCode: regex },
                { 'routeSnapshot.routeNumber': regex },
                { 'routeSnapshot.name': regex }
            ]
        });

        const keywordOr = [
            { txnRef: regex },
            { note: regex },
            { 'rawReturn.promoCode': regex },
            { 'rawReturn.orderCode': regex }
        ];

        if (matchedUserIds.length > 0) {
            keywordOr.push({ userId: { $in: matchedUserIds } });
        }

        if (matchedPassIds.length > 0) {
            keywordOr.push({ relatedMonthlyPassId: { $in: matchedPassIds } });
        }

        conditions.push({ $or: keywordOr });
    }

    if (conditions.length) {
        filter.$and = conditions;
    }

    return filter;
};

const sendPromotionUsageHistory = async (req, res, promotionId = '') => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const page = Math.max(parsePositiveInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parsePositiveInt(req.query.limit) || 10, 1), 50);
        const filter = await buildPromotionUsageHistoryFilter({
            promotionId,
            q: req.query.q,
            status: req.query.status
        });

        const total = await WalletTransaction.countDocuments(filter);
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const currentPage = Math.min(page, totalPages);
        const skip = (currentPage - 1) * limit;

        const history = await WalletTransaction.find(filter)
            .populate('userId', 'fullName email phone avatar')
            .populate('relatedMonthlyPassId', 'passCode month year passType routeSnapshot')
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        return res.json({
            ok: true,
            history: history.map((tx) => ({
                _id: tx._id,
                txnRef: tx.txnRef,
                amount: tx.amount,
                originalAmount: tx.originalAmount,
                discountAmount: tx.discountAmount,
                direction: tx.direction,
                txnType: tx.txnType,
                method: tx.method,
                status: tx.status,
                note: tx.note,
                paidAt: tx.paidAt,
                createdAt: tx.createdAt,
                rawReturn: tx.rawReturn || {},
                user: tx.userId ? {
                    _id: tx.userId._id,
                    fullName: tx.userId.fullName,
                    email: tx.userId.email,
                    phone: tx.userId.phone,
                    avatar: normalizeAvatarPath(tx.userId.avatar)
                } : null,
                monthlyPass: tx.relatedMonthlyPassId ? {
                    _id: tx.relatedMonthlyPassId._id,
                    passCode: tx.relatedMonthlyPassId.passCode,
                    month: tx.relatedMonthlyPassId.month,
                    year: tx.relatedMonthlyPassId.year,
                    passType: tx.relatedMonthlyPassId.passType,
                    routeSnapshot: tx.relatedMonthlyPassId.routeSnapshot || {}
                } : null
            })),
            total,
            totalPages,
            page: currentPage,
            limit
        });
    } catch (err) {
        if (err?.statusCode === 400) {
            return res.status(400).json({ ok: false, message: err.message || 'Yêu cầu không hợp lệ.' });
        }
        console.error('Error fetching promotion usage history:', err);
        return res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

const LAST_OPERATION_END_CAP = '19:30';
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function toMinutes(hhmm) {
    if (!hhmm || !TIME_RE.test(String(hhmm).trim())) return null;
    const [h, m] = String(hhmm).trim().split(':').map(Number);
    return h * 60 + m;
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
        let user = await User.findById(req.user.userId).select('-password');
        if (!user) {
            return res.status(404).json({ ok: false, message: 'NgÆ°á»i dÃ¹ng khÃ´ng tá»“n táº¡i' });
        }

        await applyPriorityExpiryForUser(user._id);
        user = await User.findById(user._id).select('-password');
        const priorityProfile = await getLatestPriorityProfileForUser(user._id);

        res.json({
            ok: true,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phone: user.phone,
                avatar: normalizeAvatarPath(user.avatar),
                role: user.role,
                isVerified: user.isVerified,
                walletBalance: user.walletBalance || 0,
                priorityProfile: mapPriorityProfileForApi(user, priorityProfile)
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
                avatar: normalizeAvatarPath(user.avatar)
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
router.post(
    '/user/register-priority',
    authMiddleware,
    priorityProfileUpload.fields([
        { name: 'cardImageFront', maxCount: 1 },
        { name: 'cardImageBack', maxCount: 1 },
        { name: 'proofImage', maxCount: 1 }
    ]),
    async (req, res) => {
        try {
            const body = req.body || {};
            const type = String(body.type || '').trim();
            const cardNumber = String(body.cardNumber || '').trim();
            let user = await User.findById(req.user.userId);

            if (!user) {
                return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
            }

            await applyPriorityExpiryForUser(user._id);
            user = await User.findById(user._id);

            if (!type || !cardNumber) {
                return res.status(400).json({ ok: false, message: 'Vui lòng nhập loại ưu tiên và số thẻ.' });
            }
            if (!['Student', 'War Veteran', 'Disabled', 'Elderly', 'Other'].includes(type)) {
                return res.status(400).json({ ok: false, message: 'Loại ưu tiên không hợp lệ.' });
            }

            const existingProfile = await getLatestPriorityProfileForUser(user._id);
            const currentPriorityStatus = normalizePriorityProfileStatus(
                user?.priorityStatus || user?.priorityProfile?.status || existingProfile?.status || 'NONE'
            );
            if (['PENDING', 'APPROVED'].includes(currentPriorityStatus)) {
                return res.status(409).json({ ok: false, message: 'Hồ sơ ưu tiên của bạn đang chờ duyệt hoặc đang hoạt động.' });
            }

            const cardImageFront = resolvePriorityFilePath(req.files, 'cardImageFront', body.cardImageFront);
            const cardImageBack = resolvePriorityFilePath(req.files, 'cardImageBack', body.cardImageBack);
            const proofImage = resolvePriorityFilePath(req.files, 'proofImage', body.proofImage);
            if (!cardImageFront || !cardImageBack || !proofImage) {
                return res.status(400).json({ ok: false, message: 'Vui lòng tải lên đầy đủ 3 ảnh giấy tờ.' });
            }

            user.priorityProfile = {
                cardNumber,
                cardImageFront,
                cardImageBack,
                expiryDate: null,
                status: 'PENDING'
            };
            user.isPriorityGroup = false;
            user.priorityStatus = 'PENDING';

            await user.save();
            const priorityProfile = await PriorityProfile.create({
                userId: user._id,
                category: type || 'Other',
                idNumber: cardNumber || 'N/A',
                idCardImageFront: cardImageFront || '',
                idCardImageBack: cardImageBack || '',
                proofImage: proofImage || '',
                status: 'pending',
                rejectionReason: null,
                expiryDate: null
            });
            await emitPendingPriorityCount();

            return res.json({
                ok: true,
                message: 'Hồ sơ ưu tiên đã được gửi. Đang chờ xác nhận.',
                priorityProfile: mapPriorityProfileForApi(user, priorityProfile)
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
        let user = await User.findById(req.user.userId).select('priorityProfile priorityStatus');
        if (!user) {
            return res.status(404).json({ ok: false, message: 'Người dùng không tồn tại' });
        }
        await applyPriorityExpiryForUser(user._id);
        user = await User.findById(req.user.userId).select('priorityProfile priorityStatus');
        const priorityProfile = await getLatestPriorityProfileForUser(req.user.userId);

        res.json({
            ok: true,
            priorityProfile: mapPriorityProfileForApi(user, priorityProfile)
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

	router.get('/user/trip-tickets/:ticketId/qr', authMiddleware, async (req, res) => {
	    try {
	        const ticketId = String(req.params.ticketId || '').trim();
	        if (!mongoose.Types.ObjectId.isValid(ticketId)) {
	            return res.status(400).send('Invalid ticket id');
	        }

	        const ticket = await TripTicket.findOne({
	            _id: ticketId,
	            userId: req.user.userId
	        }).lean();

	        if (!ticket || !ticket.qrCode) {
	            return res.status(404).send('Ticket not found');
	        }

	        const qrBuffer = await QRCode.toBuffer(String(ticket.qrCode).trim(), {
	            type: 'png',
	            width: 220,
	            margin: 1,
	            errorCorrectionLevel: 'M'
	        });

	        res.setHeader('Content-Type', 'image/png');
	        res.setHeader('Cache-Control', 'private, max-age=300');
	        return res.send(qrBuffer);
	    } catch (error) {
	        console.error('Error generating trip ticket QR:', error);
	        return res.status(500).send('QR generation failed');
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
        const now = new Date();

        await releaseExpiredPromotionReservations(now);

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
            return res.status(400).json({ ok: false, message: 'Giá vé tháng chưa được cấu hình.' });
        }

        const priorityDiscount = await getPriorityDiscountInfo(userId, fareMatrix);
        const priorityDiscountAmount = Math.round((basePrice * Number(priorityDiscount.discountPercent || 0)) / 100);
        const priceAfterPriority = Math.max(0, basePrice - priorityDiscountAmount);

        if (!promoCode) {
            return res.json({
                ok: true,
                applied: false,
                message: 'Chưa nhập mã giảm giá.',
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
            now
        });

        return res.json({
            ok: true,
            applied: true,
            message: `Áp mã ${promotion.code} thành công, giảm ${discountAmount.toLocaleString('vi-VN')} đ.`,
            promoCode: promotion.code,
            basePrice,
            discountPercent: Number(priorityDiscount.discountPercent || 0),
            priceAfterPriority,
            promoDiscountAmount: discountAmount,
            finalPrice: Math.max(1, priceAfterPriority - discountAmount)
        });
    } catch (error) {
        return res.status(400).json({
            ok: false,
            message: error?.message || 'Không thể kiểm tra mã giảm giá.'
        });
    }
});

/**
 * POST /api/user/passes/monthly/checkout
 * JWT checkout, trả về paymentUrl để frontend tự redirect
 */
router.post('/user/passes/monthly/checkout', authMiddleware, async (req, res) => {
    let pendingTx = null;
    let promoReserved = null;
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
        const pendingCutoff = new Date(now.getTime() - (PROMO_RESERVATION_TTL_MINUTES * 60 * 1000));

        await releaseExpiredPromotionReservations(now);
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
            return res.status(409).json({
                ok: false,
                message: 'Vé tháng cho kỳ này đã tồn tại trong tài khoản của bạn.',
                existingPassId: duplicate._id,
                passType,
                routeId: passType === PASS_TYPE.SINGLE_ROUTE ? routeId : '',
                month,
                year
            });
        }

        const pendingFilter = {
            userId,
            txnType: 'MONTHLY_PASS',
            status: 'PENDING',
            createdAt: { $gt: pendingCutoff },
            'rawReturn.passType': passType,
            'rawReturn.month': month,
            'rawReturn.year': year
        };
        if (passType === PASS_TYPE.SINGLE_ROUTE) {
            pendingFilter['rawReturn.routeId'] = routeId;
        }

        const existingPendingTxn = await WalletTransaction.findOne(pendingFilter)
            .select('_id txnRef createdAt')
            .lean();
        if (existingPendingTxn) {
            return res.status(409).json({
                ok: false,
                message: 'Bạn đang có một phiên thanh toán chưa hoàn tất cho kỳ vé này. Vui lòng thanh toán xong hoặc đợi phiên hiện tại hết hạn.',
                txnRef: existingPendingTxn.txnRef,
                month,
                year,
                passType,
                routeId: passType === PASS_TYPE.SINGLE_ROUTE ? routeId : ''
            });
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
            try {
                const promoResult = await reservePromotionForMonthlyPass({
                    promoCode,
                    userId,
                    passType,
                    routeId,
                    baseForPromo: priceAfterPriority,
                    now
                });
                promoReserved = promoResult.promotion;
                promotion = promoReserved;
                promoDiscount = promoResult.discountAmount;
            } catch (promoError) {
                return res.status(400).json({
                    ok: false,
                    message: promoError?.message || 'Không thể áp mã giảm giá cho vé tháng này.'
                });
            }
        }

        const finalPrice = Math.max(1, priceAfterPriority - promoDiscount);
        const orderCode = toOrderCode();
        const txnRef = `${paymentMethod}-MP-${orderCode}`;

        pendingTx = await WalletTransaction.create({
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
                routeSnapshot: passType === PASS_TYPE.SINGLE_ROUTE
                    ? buildRouteSnapshot(route, { routeId })
                    : { routeId: '', routeNumber: 'LT', name: 'Ve lien tuyen' },
                month,
                year,
                promoCode: promotion?.code || '',
                promotionId: promotion?._id || '',
                promoDiscount,
                promoReleased: false,
                promoConsumed: false,
                promoReserved: Boolean(promotion?._id)
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
            const redirectUrl = process.env.MOMO_MONTHLY_RETURN_URL || `${buildBaseUrl(req)}/api/user/passes/monthly/momo-return`;
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
        if (pendingTx?._id) {
            try {
                await markMonthlyPassTransactionFailed(
                    pendingTx,
                    'FAILED',
                    error?.message || 'Không thể khởi tạo thanh toán.'
                );
            } catch (markErr) {
                console.error('Failed to mark monthly pass checkout transaction as failed:', markErr);
            }
            try {
                await markPromotionReservationReleasedForTransaction(pendingTx._id);
            } catch (releaseErr) {
                console.error('Failed to release promotion reservation for checkout:', releaseErr);
            }
        } else if (promoReserved?._id) {
            try {
                await releasePromotionUsageSlot(promoReserved._id);
            } catch (releaseErr) {
                console.error('Failed to release promotion usage slot after checkout error:', releaseErr);
            }
        }
        return res.status(500).json({ ok: false, message: error?.message || 'Không thể khởi tạo thanh toán.' });
    }
});

router.get('/user/passes/monthly/vnpay-return', async (req, res) => {
    let tx = null;
    try {
        const query = { ...req.query };
        const { hashSecret } = getVnpayBaseConfig(req);

        if (!hashSecret) {
            return res.redirect(buildFrontendUrl('/monthly-pass', {
                error: 'Thieu cau hinh VNPAY hash secret.'
            }));
        }
        if (!query.vnp_TxnRef) {
            return res.redirect(buildFrontendUrl('/monthly-pass', {
                error: 'Thieu thong tin giao dich VNPAY.'
            }));
        }
        if (!verifyVnpChecksum(query, hashSecret)) {
            return res.redirect(buildFrontendUrl('/monthly-pass', {
                error: 'Chu ky VNPAY khong hop le.'
            }));
        }

        tx = await WalletTransaction.findOne({ txnRef: query.vnp_TxnRef });
        if (!tx) {
            return res.redirect(buildFrontendUrl('/monthly-pass', {
                error: 'Khong tim thay giao dich VNPAY.'
            }));
        }
        if (tx.status === 'SUCCESS') {
            return res.redirect(buildMonthlyPassResultRedirectFromTransaction(
                tx,
                'success',
                'Giao dich da duoc xac nhan thanh cong.',
                tx.relatedMonthlyPassId
            ));
        }
        if (tx.status === 'FAILED' || tx.status === 'CANCELLED') {
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(
                tx,
                'error',
                tx.note || 'Giao dich VNPAY khong thanh cong.'
            ));
        }

        const vnpAmount = Number(query.vnp_Amount || 0) / 100;
        if (!vnpAmount || Number(tx.amount) !== vnpAmount) {
            await markMonthlyPassTransactionFailed(tx, 'FAILED', 'Invalid VNPAY amount.', query);
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(tx, 'error', 'Sai lech so tien giao dich.'));
        }

        const isSuccess = query.vnp_ResponseCode === '00'
            && (!query.vnp_TransactionStatus || query.vnp_TransactionStatus === '00');

        if (!isSuccess) {
            const nextStatus = query.vnp_ResponseCode === '24' ? 'CANCELLED' : 'FAILED';
            const message = nextStatus === 'CANCELLED'
                ? 'Ban da huy thanh toan VNPAY va quay lai man hinh mua ve.'
                : 'Thanh toan VNPAY that bai. Vui long thu lai.';
            await markMonthlyPassTransactionFailed(
                tx,
                nextStatus,
                `VNPAY failed (${query.vnp_ResponseCode || 'N/A'})`,
                query
            );
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(tx, 'error', message));
        }

        let pass;
        try {
            pass = await createMonthlyPassFromTransaction(tx);
        } catch (activationError) {
            try {
                await markMonthlyPassTransactionFailed(
                    tx,
                    'FAILED',
                    `Payment confirmed but monthly pass activation failed: ${activationError?.message || 'Unknown error.'}`,
                    query
                );
            } catch (updateErr) {
                console.error('Failed to mark VNPAY activation error:', updateErr);
            }
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(
                tx,
                'error',
                'Thanh toan da duoc ghi nhan nhung kich hoat ve that bai. Vui long lien he ho tro.'
            ));
        }

        try {
            await finalizePromotionUsageAfterSuccessfulPayment(tx);
        } catch (promoError) {
            console.error('Error finalizing promotion usage after VNPAY success:', promoError);
        }

        try {
            await WalletTransaction.updateOne(
                { _id: tx._id },
                {
                    $set: {
                        status: 'SUCCESS',
                        method: 'VNPAY',
                        relatedMonthlyPassId: pass?._id || null,
                        paidAt: new Date(),
                        note: `VNPAY paid txnRef ${tx.txnRef}`,
                        rawIpn: query
                    }
                }
            );
        } catch (updateErr) {
            console.error('Failed to mark VNPAY monthly pass transaction as success:', updateErr);
        }

        return res.redirect(buildMonthlyPassResultRedirectFromTransaction(
            tx,
            'success',
            'Thanh toan VNPAY thanh cong. Ve thang da duoc kich hoat.',
            pass?._id
        ));
    } catch (error) {
        console.error('Error handling monthly pass VNPAY return:', error);
        if (tx) {
            await markMonthlyPassTransactionFailed(
                tx,
                'FAILED',
                error?.message || 'Error handling VNPAY return.',
                req.query
            );
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(
                tx,
                'error',
                'Loi xu ly ket qua thanh toan VNPAY.'
            ));
        }
        return res.redirect(buildFrontendUrl('/monthly-pass', {
            error: 'Loi xu ly ket qua thanh toan VNPAY.'
        }));
    }
});

router.all('/user/passes/monthly/momo-return', async (req, res) => {
    let tx = null;
    try {
        const orderId = cleanText(req.query.orderId || req.body?.orderId);
        const resultCode = cleanText(req.query.resultCode || req.body?.resultCode);
        if (!orderId) {
            return res.redirect(buildFrontendUrl('/monthly-pass', {
                error: 'Phien thanh toan MoMo khong hop le.'
            }));
        }

        tx = await WalletTransaction.findOne({ txnRef: orderId });
        if (!tx) {
            return res.redirect(buildFrontendUrl('/monthly-pass', {
                error: 'Khong tim thay giao dich MoMo.'
            }));
        }
        if (tx.status === 'SUCCESS') {
            return res.redirect(buildMonthlyPassResultRedirectFromTransaction(
                tx,
                'success',
                'Giao dich da duoc xac nhan thanh cong.',
                tx.relatedMonthlyPassId
            ));
        }
        if (tx.status === 'FAILED' || tx.status === 'CANCELLED') {
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(
                tx,
                'error',
                tx.note || 'Giao dich MoMo khong thanh cong.'
            ));
        }

        if (resultCode !== '0') {
            const nextStatus = resultCode === '1006' ? 'CANCELLED' : 'FAILED';
            const message = nextStatus === 'CANCELLED'
                ? 'Ban da huy thanh toan MoMo va quay lai man hinh mua ve.'
                : 'Thanh toan MoMo that bai. Vui long thu lai.';
            await markMonthlyPassTransactionFailed(
                tx,
                nextStatus,
                `MoMo failed (${resultCode || 'N/A'})`,
                req.query
            );
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(tx, 'error', message));
        }

        let pass;
        try {
            pass = await createMonthlyPassFromTransaction(tx);
        } catch (activationError) {
            try {
                await markMonthlyPassTransactionFailed(
                    tx,
                    'FAILED',
                    `Payment confirmed but monthly pass activation failed: ${activationError?.message || 'Unknown error.'}`,
                    req.query
                );
            } catch (updateErr) {
                console.error('Failed to mark MoMo activation error:', updateErr);
            }
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(
                tx,
                'error',
                'Thanh toan da duoc ghi nhan nhung kich hoat ve that bai. Vui long lien he ho tro.'
            ));
        }

        try {
            await finalizePromotionUsageAfterSuccessfulPayment(tx);
        } catch (promoError) {
            console.error('Error finalizing promotion usage after MoMo success:', promoError);
        }

        try {
            await WalletTransaction.updateOne(
                { _id: tx._id },
                {
                    $set: {
                        status: 'SUCCESS',
                        method: 'MOMO',
                        relatedMonthlyPassId: pass?._id || null,
                        paidAt: new Date(),
                        note: `MoMo paid orderId ${orderId}`,
                        rawIpn: req.query
                    }
                }
            );
        } catch (updateErr) {
            console.error('Failed to mark MoMo monthly pass transaction as success:', updateErr);
        }

        return res.redirect(buildMonthlyPassResultRedirectFromTransaction(
            tx,
            'success',
            'Thanh toan MoMo thanh cong. Ve thang da duoc kich hoat.',
            pass?._id
        ));
    } catch (error) {
        console.error('Error handling monthly pass MoMo return:', error);
        if (tx) {
            await markMonthlyPassTransactionFailed(
                tx,
                'FAILED',
                error?.message || 'Error handling MoMo return.',
                req.query
            );
            return res.redirect(buildMonthlyPassPageRedirectFromTransaction(
                tx,
                'error',
                'Loi xu ly ket qua thanh toan MoMo.'
            ));
        }
        return res.redirect(buildFrontendUrl('/monthly-pass', {
            error: 'Loi xu ly ket qua thanh toan MoMo.'
        }));
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
            return res.status(400).json({ ok: false, message: 'Thiếu thông tin tuyến hoặc kỳ vé' });
        }

        await applyPriorityExpiryForUser(userId);
        const currentUser = await User.findById(userId).select("walletBalance isPriorityGroup priorityProfile");

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
            return res.status(400).json({ ok: false, message: 'Tuyến không hợp lệ hoặc đã ngừng hoạt động' });
        }

        const existingPass = await MonthlyPass.findOne({
            userId, routeId, month, year, status: { $ne: "CANCELLED" }
        }).lean();

        if (existingPass) {
            return res.status(400).json({ ok: false, message: `Bạn đã mua vé tháng cho tuyến này trong tháng ${month}/${year}` });
        }

        const { matrix: fareMatrix } = await getFareMatrix();
        const originalPrice = resolveMonthlyPassBasePrice(
            PASS_TYPE.SINGLE_ROUTE,
            Number(route.monthlyPassPrice || 0),
            fareMatrix
        );
        if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
            return res.status(400).json({ ok: false, message: 'Giá vé tháng tuyến này chưa được cấu hình' });
        }

        const priorityDiscount = await getPriorityDiscountInfo(userId, fareMatrix);
        const priorityDiscountAmount = Math.round((originalPrice * Number(priorityDiscount.discountPercent || 0)) / 100);
        const priceAfterPriority = Math.max(0, originalPrice - priorityDiscountAmount);

        let promoDiscountAmount = 0;
        let promoReserved = null;
        if (promoCode) {
            try {
                const promoResult = await reservePromotionForMonthlyPass({
                    promoCode,
                    userId,
                    passType: PASS_TYPE.SINGLE_ROUTE,
                    routeId,
                    baseForPromo: priceAfterPriority,
                    now
                });
                promoReserved = promoResult.promotion;
                promoDiscountAmount = promoResult.discountAmount;
            } catch (promoError) {
                return res.status(400).json({
                    ok: false,
                    message: promoError?.message || 'Không thể áp mã giảm giá cho vé tháng này.'
                });
            }
        }

        const price = Math.max(0, priceAfterPriority - promoDiscountAmount);
        const discountAmount = Math.max(0, originalPrice - price);

        if (currentUser.walletBalance < price) {
            if (promoReserved?._id) {
                await releasePromotionUsageSlot(promoReserved._id);
            }
            return res.status(400).json({ ok: false, message: 'Số dư ví không đủ để mua vé tháng' });
        }

        const userAfterDeduct = await User.findOneAndUpdate(
            { _id: userId, walletBalance: { $gte: price } },
            { $inc: { walletBalance: -price } },
            { new: true }
        );

        if (!userAfterDeduct) {
            if (promoReserved?._id) {
                await releasePromotionUsageSlot(promoReserved._id);
            }
            return res.status(400).json({ ok: false, message: 'Giao dịch thất bại, vui lòng thử lại' });
        }

        const { validFrom, validTo } = getMonthDateRange(year, month);
        let createdPass = null;

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
            await WalletTransaction.create({
                userId,
                amount: price,
                originalAmount: originalPrice,
                discountAmount,
                direction: "OUT",
                txnType: "MONTHLY_PASS",
                note: `Mua vé tháng tuyến ${route.routeNumber || ""} - ${route.name || ""} (${month}/${year})`,
                method: "WALLET",
                status: "SUCCESS",
                relatedMonthlyPassId: createdPass._id,
                paidAt: new Date(),
                rawReturn: {
                    promoCode: promoReserved?.code || "",
                    promotionId: promoReserved?._id || "",
                    promoDiscount: promoDiscountAmount,
                    promoReserved: Boolean(promoReserved?._id),
                    promoConsumed: Boolean(promoReserved?._id),
                    promoReleased: false
                }
            });
        } catch (createErr) {
            try {
                await User.findByIdAndUpdate(userId, { $inc: { walletBalance: price } });
            } catch (refundErr) {
                console.error('Failed to refund wallet after monthly pass create error:', refundErr);
            }
            if (createdPass?._id) {
                try {
                    await MonthlyPass.deleteOne({ _id: createdPass._id });
                } catch (deleteErr) {
                    console.error('Failed to delete monthly pass after transaction error:', deleteErr);
                }
            }
            if (promoReserved?._id) {
                try {
                    await releasePromotionUsageSlot(promoReserved._id);
                } catch (releaseErr) {
                    console.error('Failed to release promotion usage slot after monthly pass create error:', releaseErr);
                }
            }
            if (createErr?.code === 11000 && !createdPass) {
                return res.status(400).json({ ok: false, message: 'Bạn đã mua vé tháng cho tuyến này rồi' });
            }
            throw createErr;
        }

        res.json({
            ok: true,
            message: `Mua vé tháng thành công cho tuyến ${route.routeNumber} (${month}/${year})`,
            pass: createdPass,
            newBalance: userAfterDeduct.walletBalance
        });
    } catch (error) {
        console.error('Error purchasing monthly pass:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

router.get('/user/passes/monthly/:passId', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const passId = cleanText(req.params.passId);
        if (!mongoose.Types.ObjectId.isValid(passId)) {
            return res.status(400).json({ ok: false, message: 'Pass id khong hop le.' });
        }

        const pass = await MonthlyPass.findOne({ _id: passId, userId })
            .populate('routeId', 'routeNumber name')
            .lean();
        if (!pass) {
            return res.status(404).json({ ok: false, message: 'Khong tim thay ve thang.' });
        }

        return res.json({
            ok: true,
            pass: mapMonthlyPassForClient(pass)
        });
    } catch (error) {
        console.error('Error fetching monthly pass detail:', error);
        return res.status(500).json({ ok: false, message: 'Khong the tai chi tiet ve thang.' });
    }
});

router.get('/user/passes/monthly/:passId/qr', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const passId = cleanText(req.params.passId);
        if (!mongoose.Types.ObjectId.isValid(passId)) {
            return res.status(400).json({ ok: false, message: 'Pass id khong hop le.' });
        }

        const pass = await MonthlyPass.findOne({ _id: passId, userId })
            .populate('routeId', 'routeNumber name')
            .lean();
        if (!pass) {
            return res.status(404).json({ ok: false, message: 'Khong tim thay ve thang.' });
        }

        const qrBuffer = await generateMonthlyPassQrBuffer(mapMonthlyPassForClient(pass));
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(qrBuffer);
    } catch (error) {
        console.error('Error generating monthly pass QR:', error);
        return res.status(500).json({ ok: false, message: 'Khong the tao ma QR cho ve thang.' });
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

        await syncPromotionLifecycleStatuses(new Date());

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
 * GET /api/admin/promotions/usage-history
 * Auth: Required (ADMIN)
 */
router.get('/admin/promotions/usage-history', authMiddleware, async (req, res) => {
    return sendPromotionUsageHistory(req, res);
});

/**
 * GET /api/admin/promotions/:id/usage-history
 * Auth: Required (ADMIN)
 */
router.get('/admin/promotions/:id/usage-history', authMiddleware, async (req, res) => {
    return sendPromotionUsageHistory(req, res, req.params.id);
});

/**
 * POST /api/admin/promotions
 * Auth: Required (ADMIN)
 */
router.post('/admin/promotions', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

      //  const payload = mapPromotionPayloadFromApi(req.body);
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

      //  const payload = mapPromotionPayloadFromApi(req.body);
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
 * POST /api/admin/staff/:userId/reset-password
 * Reset a staff password and email the temporary password when possible
 * Auth: Required (ADMIN role)
 */
router.post('/admin/staff/:userId/reset-password', authMiddleware, async (req, res) => {
    return adminController.resetStaffPasswordApi(req, res);
});

/**
 * POST /api/admin/staff/import
 * Import staff accounts from Excel/CSV
 * Auth: Required (ADMIN role)
 */
router.post('/admin/staff/import', authMiddleware, importUpload.single('staffFile'), async (req, res) => {
    return adminController.importStaffApi(req, res);
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

        res.json({ ok: true, message: 'Đã duyệt hồ sơ' });
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

        res.json({ ok: true, message: 'Đã từ chối hồ sơ' });
    } catch (error) {
        console.error('Error rejecting profile:', error);
        res.status(500).json({ ok: false, message: 'Lá»—i server' });
    }
});

// ============================
// ADMIN ROUTE MANAGEMENT
// ============================

const ADMIN_ROUTE_STATUS = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'INACTIVE'];
const ADMIN_ROUTE_STOP_STATUS = ['ACTIVE', 'INACTIVE'];
const ADMIN_ROUTE_DAY_VALUES = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

const cleanRouteField = (value) => (typeof value === 'string' ? value.trim() : '');
const normalizeRouteIntent = (value) => (cleanRouteField(value).toLowerCase() === 'submit_review' ? 'submit_review' : 'save_draft');
const parseRouteNumber = (value) => cleanRouteField(value).toUpperCase();
const parseRouteDate = (value) => {
    const raw = cleanRouteField(value);
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const parseRouteNumeric = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const parseRouteStopItems = (items = []) => (
    Array.isArray(items)
        ? items.map((item, index) => ({
            stopId: cleanRouteField(item?.stopId),
            sequenceOrder: index + 1,
            estimatedMinutesFromStart: Math.max(0, parseRouteNumeric(item?.estimatedMinutesFromStart) ?? 0),
            distanceFromStart: Math.max(0, parseRouteNumeric(item?.distanceFromStart) ?? 0),
            pickupAllowed: item?.pickupAllowed !== false,
            dropoffAllowed: item?.dropoffAllowed !== false,
            status: ADMIN_ROUTE_STOP_STATUS.includes(cleanRouteField(item?.status).toUpperCase())
                ? cleanRouteField(item?.status).toUpperCase()
                : 'ACTIVE'
        })).filter((item) => item.stopId)
        : []
);
const buildLegacyRouteStops = (outboundStops = [], inboundStops = []) => ([
    ...outboundStops.map((item, index) => ({
        stopId: item.stopId,
        orderIndex: index + 1,
        direction: 'OUTBOUND',
        distanceFromStart: item.distanceFromStart ?? 0
    })),
    ...inboundStops.map((item, index) => ({
        stopId: item.stopId,
        orderIndex: index + 1,
        direction: 'INBOUND',
        distanceFromStart: item.distanceFromStart ?? 0
    }))
]);
const populateAdminRouteQuery = (query) => (
    query
        .populate('startStopId', 'name address isTerminal status lat lng')
        .populate('endStopId', 'name address isTerminal status lat lng')
        .populate('directions.outbound.stops.stopId', 'name address isTerminal status lat lng')
        .populate('directions.inbound.stops.stopId', 'name address isTerminal status lat lng')
        .populate('stops.stopId', 'name address isTerminal status lat lng')
);
const mapLegacyDirectionStops = (route, direction) => (
    (Array.isArray(route?.stops) ? route.stops : [])
        .filter((item) => item.direction === direction && item.stopId)
        .sort((a, b) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0))
        .map((item, index) => ({
            stopRefId: String(item.stopId?._id || item.stopId),
            stopId: String(item.stopId?._id || item.stopId),
            id: String(item.stopId?._id || item.stopId),
            name: item.stopId?.name || '',
            address: item.stopId?.address || '',
            lat: item.stopId?.lat ?? null,
            lng: item.stopId?.lng ?? null,
            estimatedMinutesFromStart: item.estimatedMinutesFromStart ?? 0,
            distanceFromStart: item.distanceFromStart ?? 0,
            pickupAllowed: item.pickupAllowed !== false,
            dropoffAllowed: item.dropoffAllowed !== false,
            status: item.status || 'ACTIVE',
            sequenceOrder: index + 1
        }))
);
const mapDirectionStopsForApi = (items = []) => (
    items.map((item, index) => ({
        stopRefId: String(item.stopId?._id || item.stopId),
        stopId: String(item.stopId?._id || item.stopId),
        id: String(item.stopId?._id || item.stopId),
        name: item.stopId?.name || '',
        address: item.stopId?.address || '',
        lat: item.stopId?.lat ?? null,
        lng: item.stopId?.lng ?? null,
        estimatedMinutesFromStart: item.estimatedMinutesFromStart ?? 0,
        distanceFromStart: item.distanceFromStart ?? 0,
        pickupAllowed: item.pickupAllowed !== false,
        dropoffAllowed: item.dropoffAllowed !== false,
        status: item.status || 'ACTIVE',
        sequenceOrder: index + 1
    }))
);
const serializeAdminRoute = (route) => {
    const outboundStops = route?.directions?.outbound?.stops?.length
        ? mapDirectionStopsForApi(route.directions.outbound.stops)
        : mapLegacyDirectionStops(route, 'OUTBOUND');
    const inboundStops = route?.directions?.inbound?.stops?.length
        ? mapDirectionStopsForApi(route.directions.inbound.stops)
        : mapLegacyDirectionStops(route, 'INBOUND');

    return {
        ...route,
        routeCode: route.routeNumber || '',
        routeName: route.name || '',
        startStop: route.startStopId
            ? {
                _id: String(route.startStopId._id || route.startStopId),
                id: String(route.startStopId._id || route.startStopId),
                name: route.startStopId.name || '',
                address: route.startStopId.address || '',
                isTerminal: Boolean(route.startStopId.isTerminal),
                status: route.startStopId.status || 'ACTIVE',
                lat: route.startStopId.lat ?? null,
                lng: route.startStopId.lng ?? null
            }
            : null,
        endStop: route.endStopId
            ? {
                _id: String(route.endStopId._id || route.endStopId),
                id: String(route.endStopId._id || route.endStopId),
                name: route.endStopId.name || '',
                address: route.endStopId.address || '',
                isTerminal: Boolean(route.endStopId.isTerminal),
                status: route.endStopId.status || 'ACTIVE',
                lat: route.endStopId.lat ?? null,
                lng: route.endStopId.lng ?? null
            }
            : null,
        outboundStops,
        inboundStops,
        stopCount: outboundStops.length
    };
};
const appendRouteAuditLog = (route, { action, fromStatus = null, toStatus = null, message = '', performedBy = null }) => {
    route.auditLogs = [
        ...(Array.isArray(route.auditLogs) ? route.auditLogs : []),
        {
            action,
            fromStatus,
            toStatus,
            message,
            performedBy,
            performedAt: new Date()
        }
    ];
};
const buildRouteNameFromStops = (startStop, endStop) => {
    const startName = cleanRouteField(startStop?.name);
    const endName = cleanRouteField(endStop?.name);
    return startName && endName ? `${startName} - ${endName}` : '';
};
async function validateAdminRoutePayload(payload, { routeId = null, strict = false } = {}) {
    const errors = [];

    if (!payload.routeCode) errors.push('Ma tuyen la bat buoc.');
    if (payload.startPoint && !mongoose.Types.ObjectId.isValid(payload.startPoint)) errors.push('Diem dau khong hop le.');
    if (payload.endPoint && !mongoose.Types.ObjectId.isValid(payload.endPoint)) errors.push('Diem cuoi khong hop le.');
    if (payload.startPoint && payload.endPoint && payload.startPoint === payload.endPoint) {
        errors.push('Diem dau va diem cuoi khong duoc trung nhau.');
    }

    const allStopIds = [
        payload.startPoint,
        payload.endPoint,
        ...payload.outboundStops.map((item) => item.stopId),
        ...payload.inboundStops.map((item) => item.stopId)
    ].filter(Boolean);

    const invalidStopId = allStopIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidStopId) errors.push('Danh sach tram co stopId khong hop le.');

    let stopMap = new Map();
    if (!invalidStopId && allStopIds.length) {
        const stops = await Stop.find({ _id: { $in: [...new Set(allStopIds)] } })
            .select('_id name address isTerminal status lat lng')
            .lean();
        stopMap = new Map(stops.map((stop) => [String(stop._id), stop]));
        if (stopMap.size !== [...new Set(allStopIds)].length) {
            errors.push('Co tram khong ton tai trong hanh trinh.');
        }
    }

    const duplicateRoute = payload.routeCode
        ? await Route.findOne({
            routeNumber: payload.routeCode,
            ...(routeId ? { _id: { $ne: routeId } } : {})
        }).lean()
        : null;
    if (duplicateRoute) errors.push(`Ma tuyen "${payload.routeCode}" da ton tai.`);

    if (strict) {
        const distance = parseRouteNumeric(payload.distance);
        if (!payload.startPoint) errors.push('Diem dau la bat buoc.');
        if (!payload.endPoint) errors.push('Diem cuoi la bat buoc.');
        if (!Number.isFinite(distance) || distance <= 0) errors.push('Cu ly la bat buoc va phai lon hon 0.');
        if (!payload.effectiveDateRaw || !payload.effectiveDate) errors.push('Ngay hieu luc la bat buoc khi gui duyet.');
        if (!payload.startTime || !payload.endTime) errors.push('Gio van hanh la bat buoc.');
        if ((payload.startTime && !HHMM_REGEX.test(payload.startTime)) || (payload.endTime && !HHMM_REGEX.test(payload.endTime))) {
            errors.push('Gio van hanh khong dung dinh dang HH:mm.');
        }
        if (HHMM_REGEX.test(payload.startTime) && HHMM_REGEX.test(payload.endTime) && payload.startTime >= payload.endTime) {
            errors.push('Gio bat dau phai som hon gio ket thuc.');
        }
        if (!Number.isFinite(parseRouteNumeric(payload.tripInterval)) || Number(payload.tripInterval) <= 0) {
            errors.push('Tan suat chay la bat buoc.');
        }
        if (!Number.isFinite(parseRouteNumeric(payload.estimatedRouteDuration)) || Number(payload.estimatedRouteDuration) <= 0) {
            errors.push('Thoi gian hanh trinh la bat buoc.');
        }
        if (!Array.isArray(payload.operatingDays) || payload.operatingDays.length === 0) {
            errors.push('Vui long chon it nhat 1 ngay van hanh.');
        }
        if (payload.outboundStops.length < 2) errors.push('Chieu di phai co it nhat 2 tram.');
        if (payload.inboundStops.length < 2) errors.push('Chieu ve phai co it nhat 2 tram.');

        if (payload.outboundStops.length) {
            if (payload.startPoint && payload.outboundStops[0]?.stopId !== payload.startPoint) {
                errors.push('Chieu di phai bat dau tu dung diem.');
            }
            if (payload.endPoint && payload.outboundStops[payload.outboundStops.length - 1]?.stopId !== payload.endPoint) {
                errors.push('Chieu di phai ket thuc tai dung diem.');
            }
        }

        if (payload.inboundStops.length) {
            if (payload.endPoint && payload.inboundStops[0]?.stopId !== payload.endPoint) {
                errors.push('Chieu ve phai bat dau tu dung diem.');
            }
            if (payload.startPoint && payload.inboundStops[payload.inboundStops.length - 1]?.stopId !== payload.startPoint) {
                errors.push('Chieu ve phai ket thuc tai dung diem.');
            }
        }
    }

    const startStop = payload.startPoint ? stopMap.get(payload.startPoint) : null;
    const endStop = payload.endPoint ? stopMap.get(payload.endPoint) : null;
    return {
        errors: [...new Set(errors)],
        startStop,
        endStop,
        routeName: payload.routeName || buildRouteNameFromStops(startStop, endStop)
    };
}
const normalizeAdminRoutePayload = (body = {}) => ({
    intent: normalizeRouteIntent(body.intent),
    routeCode: parseRouteNumber(body.routeCode || body.routeNumber),
    routeName: cleanRouteField(body.routeName || body.name),
    startPoint: cleanRouteField(body.startPoint || body.startStopId),
    endPoint: cleanRouteField(body.endPoint || body.endStopId),
    description: cleanRouteField(body.description),
    effectiveDateRaw: cleanRouteField(body.effectiveDate),
    effectiveDate: parseRouteDate(body.effectiveDate),
    monthlyPassPrice: parseRouteNumeric(body.monthlyPassPrice) ?? 200000,
    distance: parseRouteNumeric(body.distance),
    routeType: cleanRouteField(body.routeType),
    serviceType: cleanRouteField(body.serviceType),
    startTime: cleanRouteField(body.startTime || body.operationSettings?.startTime || body.operationTime?.start),
    endTime: cleanRouteField(body.endTime || body.operationSettings?.endTime || body.operationTime?.end),
    tripInterval: parseRouteNumeric(body.tripInterval ?? body.operationSettings?.tripInterval ?? body.frequencyMinutes),
    estimatedRouteDuration: parseRouteNumeric(body.estimatedRouteDuration ?? body.operationSettings?.estimatedRouteDuration ?? body.roundTripMinutes),
    turnaroundTime: parseRouteNumeric(body.turnaroundTime ?? body.operationSettings?.turnaroundTime ?? body.bufferMinutes),
    operatingDays: Array.isArray(body.operatingDays)
        ? body.operatingDays.map((item) => cleanRouteField(item).toUpperCase()).filter((item) => ADMIN_ROUTE_DAY_VALUES.includes(item))
        : [],
    notes: cleanRouteField(body.notes || body.operationSettings?.notes),
    outboundStops: parseRouteStopItems(body.outboundStops),
    inboundStops: parseRouteStopItems(body.inboundStops)
});

/**
 * GET /api/admin/routes/metadata
 * Get stops lookup for route form
 */
router.get('/admin/routes/metadata', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const availableStops = await Stop.find({})
            .sort({ status: 1, isTerminal: -1, name: 1 })
            .select('_id name address isTerminal status lat lng')
            .lean();

        res.json({ ok: true, availableStops });
    } catch (error) {
        console.error('Error fetching route metadata:', error);
        res.status(500).json({ ok: false, message: 'Loi server' });
    }
});

/**
 * GET /api/admin/routes
 * Get all routes for Admin
 */
router.get('/admin/routes', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const { q, status } = req.query;
        const filter = {};

        if (q) {
            filter.$or = [
                { routeNumber: { $regex: q, $options: 'i' } },
                { name: { $regex: q, $options: 'i' } },
                { description: { $regex: q, $options: 'i' } }
            ];
        }

        if (status && ADMIN_ROUTE_STATUS.includes(String(status).toUpperCase())) {
            filter.status = String(status).toUpperCase();
        }

        const routes = await populateAdminRouteQuery(Route.find(filter))
            .sort({ routeNumber: 1, createdAt: -1 })
            .lean();

        res.json({ ok: true, routes: routes.map(serializeAdminRoute) });
    } catch (error) {
        console.error('Error fetching admin routes:', error);
        res.status(500).json({ ok: false, message: 'Loi server' });
    }
});

/**
 * GET /api/admin/routes/:id
 * Get route details for route form
 */
router.get('/admin/routes/:id', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const route = await populateAdminRouteQuery(Route.findById(req.params.id)).lean();
        if (!route) {
            return res.status(404).json({ ok: false, message: 'Khong tim thay tuyen' });
        }

        res.json({ ok: true, route: serializeAdminRoute(route) });
    } catch (error) {
        console.error('Error fetching admin route detail:', error);
        res.status(500).json({ ok: false, message: 'Loi server' });
    }
});

/**
 * POST /api/admin/routes/create
 */
router.post('/admin/routes/create', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

       // const payload = normalizeAdminRoutePayload(req.body);
        const strict = payload.intent === 'submit_review';
        const { errors, routeName } = await validateAdminRoutePayload(payload, { strict });
        if (errors.length) {
            return res.status(400).json({ ok: false, message: errors[0], errors });
        }

        const nextStatus = strict ? 'PENDING_REVIEW' : 'DRAFT';
        const newRoute = await Route.create({
            routeNumber: payload.routeCode,
            name: routeName || '',
            description: payload.description,
            distance: payload.distance ?? 0,
            routeType: payload.routeType,
            serviceType: payload.serviceType,
            startStopId: payload.startPoint || null,
            endStopId: payload.endPoint || null,
            effectiveDate: payload.effectiveDate,
            monthlyPassPrice: payload.monthlyPassPrice,
            status: nextStatus,
            operationTime: {
                start: payload.startTime || '',
                end: payload.endTime || ''
            },
            frequencyMinutes: payload.tripInterval ?? 15,
            roundTripMinutes: payload.estimatedRouteDuration ?? 60,
            bufferMinutes: payload.turnaroundTime ?? 10,
            operationSettings: {
                operatingDays: payload.operatingDays,
                startTime: payload.startTime || '',
                endTime: payload.endTime || '',
                tripInterval: payload.tripInterval,
                estimatedRouteDuration: payload.estimatedRouteDuration,
                turnaroundTime: payload.turnaroundTime,
                notes: payload.notes
            },
            directions: {
                outbound: {
                    directionKey: 'OUTBOUND',
                    startStopId: payload.startPoint || null,
                    endStopId: payload.endPoint || null,
                    stops: payload.outboundStops
                },
                inbound: {
                    directionKey: 'INBOUND',
                    startStopId: payload.endPoint || null,
                    endStopId: payload.startPoint || null,
                    stops: payload.inboundStops
                }
            },
            stops: buildLegacyRouteStops(payload.outboundStops, payload.inboundStops),
            createdBy: req.user.userId,
            updatedBy: req.user.userId
        });

        res.json({
            ok: true,
            message: strict ? 'Gui duyet route thanh cong' : 'Luu nhap route thanh cong',
            route: newRoute
        });

        if (frequencyMinutes != null) payload.frequencyMinutes = Math.max(1, Number(frequencyMinutes) || 15);
        if (roundTripMinutes != null) payload.roundTripMinutes = Math.max(1, Number(roundTripMinutes) || 60);
        if (bufferMinutes != null) payload.bufferMinutes = Math.max(0, Number(bufferMinutes) || 0);

        if (startTime && endTime) {
            const start = startTime.trim();
            const end = endTime.trim();
            if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
                return res.status(400).json({ ok: false, message: 'Giờ vận hành phải đúng định dạng HH:mm.' });
            }
            const endM = toMinutes(end);
            const capM = toMinutes(LAST_OPERATION_END_CAP);
            if (endM != null && capM != null && endM > capM) {
                return res.status(400).json({
                    ok: false,
                    message: `Giờ kết thúc không được vượt quá ${LAST_OPERATION_END_CAP}.`,
                });
            }
            payload.operationTime = { start, end };
        }


        res.json({ ok: true, message: 'Tạo tuyến thành công', route: newRoute });
    } catch (err) {
        console.error('Error creating route:', err);
        if (err.code === 11000) return res.status(400).json({ ok: false, message: 'Ma tuyen da ton tai.' });
        res.status(500).json({
            ok: false,
            message: 'Loi server',
            details: err?.message || 'Unknown error'
        });
    }
});

/**
 * PUT /api/admin/routes/:id
 */
router.put('/admin/routes/:id', authMiddleware, async (req, res) => {
  try {
    const adminUser = await ensureAdminApi(req, res);
    if (!adminUser) return;

        const route = await Route.findById(req.params.id);
        if (!route) return res.status(404).json({ ok: false, message: 'Khong tim thay tuyen' });

        const payload = normalizeAdminRoutePayload(req.body);
        const strict = payload.intent === 'submit_review';
        const { errors, routeName } = await validateAdminRoutePayload(payload, { routeId: route._id, strict });
        if (errors.length) {
            return res.status(400).json({ ok: false, message: errors[0], errors });
        }

        route.routeNumber = payload.routeCode;
        route.name = routeName || route.name || '';
        route.description = payload.description;
        route.distance = payload.distance ?? 0;
        route.routeType = payload.routeType;
        route.serviceType = payload.serviceType;
        route.startStopId = payload.startPoint || null;
        route.endStopId = payload.endPoint || null;
        route.effectiveDate = payload.effectiveDate;
        route.monthlyPassPrice = payload.monthlyPassPrice;
        route.operationTime = {
            start: payload.startTime || '',
            end: payload.endTime || ''
        };
        route.frequencyMinutes = payload.tripInterval ?? 15;
        route.roundTripMinutes = payload.estimatedRouteDuration ?? 60;
        route.bufferMinutes = payload.turnaroundTime ?? 10;
        route.operationSettings = {
            operatingDays: payload.operatingDays,
            startTime: payload.startTime || '',
            endTime: payload.endTime || '',
            tripInterval: payload.tripInterval,
            estimatedRouteDuration: payload.estimatedRouteDuration,
            turnaroundTime: payload.turnaroundTime,
            notes: payload.notes
        };
        route.directions = {
            outbound: {
                directionKey: 'OUTBOUND',
                startStopId: payload.startPoint || null,
                endStopId: payload.endPoint || null,
                stops: payload.outboundStops
            },
            inbound: {
                directionKey: 'INBOUND',
                startStopId: payload.endPoint || null,
                endStopId: payload.startPoint || null,
                stops: payload.inboundStops
            }
        };
        route.stops = buildLegacyRouteStops(payload.outboundStops, payload.inboundStops);
        route.updatedBy = req.user.userId;

        if (strict && ['DRAFT', 'REJECTED'].includes(route.status)) {
            route.status = 'PENDING_REVIEW';
        } else if (!strict && !route.status) {
            route.status = 'DRAFT';
        }

        await route.save();
        res.json({ ok: true, message: strict ? 'Gui duyet route thanh cong' : 'Cap nhat route thanh cong', route });
    } catch (err) {
        console.error('Error updating route:', err);
        if (err.code === 11000) return res.status(400).json({ ok: false, message: 'Ma tuyen da ton tai.' });
        res.status(500).json({
            ok: false,
            message: 'Loi server',
            details: err?.message || 'Unknown error'
        });
    }

 //   const payload = normalizeAdminRoutePayload(req.body);
    const strict = payload.intent === 'submit_review';

    const { errors, routeName } = await validateAdminRoutePayload(payload, {
      routeId: route._id,
      strict
    });

    if (errors.length) {
      return res.status(400).json({ ok: false, message: errors[0], errors });
    }

    // ===== UPDATE DATA =====
    route.routeNumber = payload.routeCode;
    route.name = routeName || route.name || '';
    route.description = payload.description;
    route.distance = payload.distance ?? 0;
    route.routeType = payload.routeType;
    route.serviceType = payload.serviceType;
    route.startStopId = payload.startPoint || null;
    route.endStopId = payload.endPoint || null;
    route.effectiveDate = payload.effectiveDate;
    route.monthlyPassPrice = payload.monthlyPassPrice;

    // ===== TIME =====
    if (payload.startTime && payload.endTime) {
      const start = payload.startTime.trim();
      const end = payload.endTime.trim();

      if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
        return res.status(400).json({
          ok: false,
          message: 'Giờ vận hành phải đúng định dạng HH:mm.'
        });
      }

      const endM = toMinutes(end);
      const capM = toMinutes(LAST_OPERATION_END_CAP);

      if (endM != null && capM != null && endM > capM) {
        return res.status(400).json({
          ok: false,
          message: `Giờ kết thúc không được vượt quá ${LAST_OPERATION_END_CAP}.`
        });
      }

      route.operationTime = { start, end };
    }

    // ===== SETTINGS =====
    route.frequencyMinutes = payload.tripInterval ?? 15;
    route.roundTripMinutes = payload.estimatedRouteDuration ?? 60;
    route.bufferMinutes = payload.turnaroundTime ?? 10;

    route.operationSettings = {
      operatingDays: payload.operatingDays,
      startTime: payload.startTime || '',
      endTime: payload.endTime || '',
      tripInterval: payload.tripInterval,
      estimatedRouteDuration: payload.estimatedRouteDuration,
      turnaroundTime: payload.turnaroundTime,
      notes: payload.notes
    };

    // ===== DIRECTIONS =====
    route.directions = {
      outbound: {
        directionKey: 'OUTBOUND',
        startStopId: payload.startPoint || null,
        endStopId: payload.endPoint || null,
        stops: payload.outboundStops
      },
      inbound: {
        directionKey: 'INBOUND',
        startStopId: payload.endPoint || null,
        endStopId: payload.startPoint || null,
        stops: payload.inboundStops
      }
    };

    route.stops = buildLegacyRouteStops(
      payload.outboundStops,
      payload.inboundStops
    );

    route.updatedBy = req.user.userId;

    // ===== STATUS =====
    if (strict && ['DRAFT', 'REJECTED'].includes(route.status)) {
      route.status = 'PENDING_REVIEW';
    } else if (!route.status) {
      route.status = 'DRAFT';
    }

    await route.save();

    return res.json({
      ok: true,
      message: strict
        ? 'Gui duyet route thanh cong'
        : 'Cap nhat route thanh cong',
      route
    });

  } catch (err) {
    console.error('Error updating route:', err);

    if (err.code === 11000) {
      return res.status(400).json({
        ok: false,
        message: 'Ma tuyen da ton tai.'
      });
    }

    return res.status(500).json({
      ok: false,
      message: 'Loi server',
      details: err?.message || 'Unknown error'
    });
  }
});

router.put('/admin/routes/:id', authMiddleware, async (req, res) => {
  try {
    const adminUser = await ensureAdminApi(req, res);
    if (!adminUser) return;

    const route = await Route.findById(req.params.id);
    if (!route) {
      return res.status(404).json({ ok: false, message: 'Khong tim thay tuyen' });
    }

   // const payload = normalizeAdminRoutePayload(req.body);
    const strict = payload.intent === 'submit_review';

    const { errors, routeName } = await validateAdminRoutePayload(payload, {
      routeId: route._id,
      strict
    });

    if (errors.length) {
      return res.status(400).json({ ok: false, message: errors[0], errors });
    }

    // update basic fields
    route.routeNumber = payload.routeCode;
    route.name = routeName || '';
    route.description = payload.description;
    route.distance = payload.distance ?? 0;

    // status logic
    if (strict && ['DRAFT', 'REJECTED'].includes(route.status)) {
      route.status = 'PENDING_REVIEW';
    } else if (!strict && !route.status) {
      route.status = 'DRAFT';
    }

    route.updatedBy = req.user.userId;

    await route.save();

    return res.json({
      ok: true,
      message: strict ? 'Gui duyet route thanh cong' : 'Cap nhat route thanh cong',
      route
    });

  } catch (err) {
    console.error('Error updating route:', err);

    if (err.code === 11000) {
      return res.status(400).json({ ok: false, message: 'Ma tuyen da ton tai.' });
    }

    return res.status(500).json({
      ok: false,
      message: 'Loi server',
      details: err?.message || 'Unknown error'
    });
  }
});
/**
 * POST /api/admin/routes/:id/approve
 */
router.post('/admin/routes/:id/approve', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const route = await Route.findById(req.params.id);
        if (!route) return res.status(404).json({ ok: false, message: 'Khong tim thay tuyen' });
        if (route.status !== 'PENDING_REVIEW') {
            return res.status(409).json({ ok: false, message: 'Chi co the duyet tuyen dang o trang thai cho duyet.' });
        }

        const fromStatus = route.status;
        route.status = 'APPROVED';
        route.updatedBy = req.user.userId;
        appendRouteAuditLog(route, {
            action: 'APPROVE_ROUTE',
            fromStatus,
            toStatus: 'APPROVED',
            message: 'Admin da duyet tuyen.',
            performedBy: req.user.userId
        });

        await route.save();
        const populatedRoute = await populateAdminRouteQuery(Route.findById(route._id)).lean();
        res.json({ ok: true, message: 'Duyet tuyen thanh cong', route: populatedRoute ? serializeAdminRoute(populatedRoute) : null });
    } catch (err) {
        console.error('Error approving route:', err);
        res.status(500).json({ ok: false, message: 'Loi server', details: err?.message || 'Unknown error' });
    }
});

/**
 * POST /api/admin/routes/:id/reject
 */
router.post('/admin/routes/:id/reject', authMiddleware, async (req, res) => {
    try {
        const adminUser = await ensureAdminApi(req, res);
        if (!adminUser) return;

        const route = await Route.findById(req.params.id);
        if (!route) return res.status(404).json({ ok: false, message: 'Khong tim thay tuyen' });
        if (route.status !== 'PENDING_REVIEW') {
            return res.status(409).json({ ok: false, message: 'Chi co the tu choi tuyen dang o trang thai cho duyet.' });
        }

        const rejectionReason = cleanRouteField(req.body?.rejectionReason);
        if (!rejectionReason) {
            return res.status(400).json({ ok: false, message: 'Vui long nhap ly do tu choi.' });
        }

        const fromStatus = route.status;
        route.status = 'REJECTED';
        route.updatedBy = req.user.userId;
        appendRouteAuditLog(route, {
            action: 'REJECT_ROUTE',
            fromStatus,
            toStatus: 'REJECTED',
            message: `Admin tu choi tuyen. Ly do: ${rejectionReason}`,
            performedBy: req.user.userId
        });

        await route.save();
        const populatedRoute = await populateAdminRouteQuery(Route.findById(route._id)).lean();
        res.json({ ok: true, message: 'Tu choi tuyen thanh cong', route: populatedRoute ? serializeAdminRoute(populatedRoute) : null });
    } catch (err) {
        console.error('Error rejecting route:', err);
        res.status(500).json({ ok: false, message: 'Loi server', details: err?.message || 'Unknown error' });
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

        let nextStatus = null;
        if (route.status === 'ACTIVE') {
            nextStatus = 'INACTIVE';
        } else if (['INACTIVE', 'APPROVED'].includes(route.status)) {
            nextStatus = 'ACTIVE';
        } else {
            return res.status(409).json({ ok: false, message: 'Trang thai hien tai khong the chuyen sang Hoat dong/Tam ngung.' });
        }
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
router.post('/admin/schedules/bulk-delete', authMiddleware, scheduleController.bulkDeleteSchedules);
router.get('/admin/schedules/:id/delete-impact', authMiddleware, scheduleController.getDeleteImpact);
router.post('/admin/schedules/:id/update-impact', authMiddleware, scheduleController.getUpdateImpact);
router.patch('/admin/schedules/:id/archive', authMiddleware, scheduleController.archiveSchedule);
router.post('/admin/schedules/create', authMiddleware, scheduleController.createSchedule);
router.put('/admin/schedules/:id', authMiddleware, scheduleController.updateSchedule);
router.delete('/admin/schedules/:id', authMiddleware, scheduleController.deleteSchedule);
router.patch('/admin/schedules/:id/log', authMiddleware, scheduleController.updateTripLog);
router.post('/driver/start-trip', authMiddleware, scheduleController.startTripV2);
router.post('/driver/finish-trip', authMiddleware, scheduleController.finishTripV2);
router.post('/driver/tracking/location', authMiddleware, scheduleController.updateTrackingLocation);
router.post('/driver/load-status', authMiddleware, scheduleController.updateLoadStatus);
router.post('/conductor/start-trip', authMiddleware, scheduleController.startTripV2);

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
            return res.status(403).json({ ok: false, message: 'Chỉ tài xế, phụ xe hoặc nhân viên mới quét được vé' });
        }
        const code = req.body?.code;
        if (!code) return res.status(400).json({ ok: false, message: 'Mã QR không được để trống' });

        const token = resolveConductorQrToken(code);
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
                return res.json({ ok: false, message: `Vé tháng không còn hiệu lực (${pass.status})` });
            }
            const validTo = pass.validTo || pass.endDate;
            if (validTo && new Date(validTo) < now) {
                return res.json({ ok: false, message: `Vé đã hết hạn (${new Date(validTo).toLocaleDateString('vi-VN')})` });
            }
            const validFrom = pass.validFrom;
            if (validFrom && new Date(validFrom) > now) {
                return res.json({ ok: false, message: `Vé chưa đến ngày hiệu lực (${new Date(validFrom).toLocaleDateString('vi-VN')})` });
            }
            return res.json({
                ok: true,
                ticketType: 'MONTHLY_PASS',
                message: 'Vé tháng hợp lệ',
                passengerName: pass.userId?.fullName,
                routeNumber: pass.routeId?.routeNumber || pass.routeSnapshot?.routeNumber,
                validUntil: validTo ? new Date(validTo).toLocaleDateString('vi-VN') : 'Không giới hạn',
                passCode: pass.passCode
            });
        }

        const ticket = await TripTicket.findOne({ qrCode: token })
            .populate('userId', 'fullName')
            .populate('routeId', 'routeNumber name')
            .populate('scheduleId', 'date departureTime shiftTime status');
        if (!ticket) {
            return res.json({ ok: false, message: 'Mã vé không tồn tại hoặc không hợp lệ' });
        }
        if (ticket.status === 'CANCELLED') return res.json({ ok: false, message: 'Vé đã bị hủy' });
        if (ticket.status === 'USED') return res.json({ ok: false, message: 'Vé đã được sử dụng' });

        ticket.status = 'USED';
        ticket.usedAt = new Date();
        await ticket.save();

        res.json({
            ok: true,
            ticketType: 'TRIP_TICKET',
            message: 'Vé lẻ hợp lệ',
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



