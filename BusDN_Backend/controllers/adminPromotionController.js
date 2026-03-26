const mongoose = require('mongoose');
const { Promotion, Route } = require('../models');
const { renderAdmin } = require('../middleware/renderAdmin');

const ALLOWED_STATUS = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED'];
const ALLOWED_SCOPE = ['ALL', 'SINGLE_ROUTE', 'INTER_ROUTE'];
const ALLOWED_DISCOUNT_TYPE = ['PERCENT', 'FIXED'];

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const upper = (v) => clean(v).toUpperCase();

function getFlash(req, key) {
    const msg = req.session?.[key] || null;
    if (req.session) delete req.session[key];
    return msg;
}

function setFlash(req, key, value) {
    if (req.session) req.session[key] = value;
}

function parseDateTime(value) {
    const raw = clean(value);
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

function parsePositiveNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
}

function toLifecycleStatus(requestedStatus, startAt, endAt, now = new Date()) {
    if (requestedStatus === 'DRAFT' || requestedStatus === 'CANCELLED' || requestedStatus === 'ENDED') {
        return requestedStatus;
    }

    if (endAt < now) return 'ENDED';
    if (startAt > now) return 'SCHEDULED';
    return 'ACTIVE';
}

async function syncPromotionLifecycleStatuses(now = new Date()) {
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
}

async function validatePayload(payload, mode = 'create') {
    const errors = [];
    const now = new Date();

    if (!payload.code) errors.push('Mã khuyến mãi là bắt buộc.');
    if (!payload.name) errors.push('Tên chương trình là bắt buộc.');

    if (!ALLOWED_DISCOUNT_TYPE.includes(payload.discountType)) {
        errors.push('Loại giảm giá không hợp lệ.');
    }

    if (!ALLOWED_SCOPE.includes(payload.applyScope)) {
        errors.push('Phạm vi áp dụng không hợp lệ.');
    }

    if (!ALLOWED_STATUS.includes(payload.status)) {
        errors.push('Trạng thái chương trình không hợp lệ.');
    }

    if (!payload.startAt || !payload.endAt) {
        errors.push('Thời gian bắt đầu và kết thúc là bắt buộc.');
    } else if (payload.endAt <= payload.startAt) {
        errors.push('Thời gian kết thúc phải lớn hơn thời gian bắt đầu.');
    } else {
        if (mode === 'create' && payload.startAt < now) {
            errors.push('Thời gian bắt đầu không được ở trong quá khứ.');
        }
        if (payload.endAt < now && payload.status !== 'ENDED' && payload.status !== 'CANCELLED') {
            errors.push('Thời gian kết thúc không được ở trong quá khứ.');
        }
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
    }

    if (payload.applyScope !== 'SINGLE_ROUTE') {
        payload.routeId = null;
    }

    if (mode === 'create' && (payload.status === 'ENDED' || payload.status === 'CANCELLED')) {
        errors.push('Không thể tạo mới với trạng thái ENDED/CANCELLED.');
    }

    return errors;
}

function mapPayload(req) {
    const code = upper(req.body.code);
    const name = clean(req.body.name);
    const description = clean(req.body.description);
    const discountType = upper(req.body.discountType) || 'PERCENT';
    const applyScope = upper(req.body.applyScope) || 'ALL';
    const status = upper(req.body.status) || 'DRAFT';

    const discountValue = parsePositiveNumber(req.body.discountValue);
    const maxDiscountValueRaw = clean(req.body.maxDiscountValue);
    const minOrderValueRaw = clean(req.body.minOrderValue);
    const usageLimitTotalRaw = clean(req.body.usageLimitTotal);
    const usageLimitPerUserRaw = clean(req.body.usageLimitPerUser);

    const startAt = parseDateTime(req.body.startAt);
    const endAt = parseDateTime(req.body.endAt);

    let routeId = clean(req.body.routeId);
    if (!routeId || !mongoose.Types.ObjectId.isValid(routeId)) routeId = null;

    return {
        code,
        name,
        description,
        discountType,
        discountValue,
        maxDiscountValue: maxDiscountValueRaw === '' ? null : parsePositiveNumber(maxDiscountValueRaw),
        minOrderValue: minOrderValueRaw === '' ? 0 : parsePositiveNumber(minOrderValueRaw),
        applyScope,
        routeId,
        startAt,
        endAt,
        status,
        usageLimitTotal: usageLimitTotalRaw === '' ? null : Number(usageLimitTotalRaw),
        usageLimitPerUser: usageLimitPerUserRaw === '' ? 1 : Number(usageLimitPerUserRaw)
    };
}

exports.getPromotionsPage = async (req, res) => {
    try {
        const q = clean(req.query.q);
        const status = upper(req.query.status);

        const filter = {};
        if (q) {
            filter.$or = [
                { code: { $regex: q, $options: 'i' } },
                { name: { $regex: q, $options: 'i' } }
            ];
        }

        if (ALLOWED_STATUS.includes(status)) {
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

        return renderAdmin(req, res, 'admin/promotions', 'Quản lý khuyến mãi', {
            promotions,
            routes,
            success: getFlash(req, 'success'),
            error: getFlash(req, 'error'),
            filters: { q, status },
            path: 'promotions'
        });
    } catch (err) {
        console.error('getPromotionsPage error:', err);
        return renderAdmin(req, res, 'admin/promotions', 'Quản lý khuyến mãi', {
            promotions: [],
            routes: [],
            success: null,
            error: 'Không thể tải danh sách chương trình khuyến mãi.',
            filters: { q: '', status: '' },
            path: 'promotions'
        });
    }
};

exports.createPromotion = async (req, res) => {
    try {
        const payload = mapPayload(req);
        const errors = await validatePayload(payload, 'create');

        if (errors.length) {
            setFlash(req, 'error', errors[0]);
            return res.redirect('/admin/promotions');
        }

        const existed = await Promotion.findOne({ code: payload.code }).lean();
        if (existed) {
            setFlash(req, 'error', `Mã khuyến mãi "${payload.code}" đã tồn tại.`);
            return res.redirect('/admin/promotions');
        }

        const now = new Date();
        const lifecycleStatus = toLifecycleStatus(payload.status, payload.startAt, payload.endAt, now);

        await Promotion.create({
            ...payload,
            status: lifecycleStatus,
            createdBy: req.session.userId || null,
            updatedBy: req.session.userId || null
        });

        setFlash(req, 'success', `Đã tạo chương trình "${payload.name}" thành công.`);
        return res.redirect('/admin/promotions');
    } catch (err) {
        console.error('createPromotion error:', err);
        if (err.code === 11000) {
            setFlash(req, 'error', 'Mã khuyến mãi đã tồn tại.');
            return res.redirect('/admin/promotions');
        }
        setFlash(req, 'error', 'Có lỗi xảy ra khi tạo chương trình khuyến mãi.');
        return res.redirect('/admin/promotions');
    }
};

exports.updatePromotion = async (req, res) => {
    try {
        const { id } = req.params;
        const promotion = await Promotion.findById(id);
        if (!promotion) {
            setFlash(req, 'error', 'Không tìm thấy chương trình cần cập nhật.');
            return res.redirect('/admin/promotions');
        }

        const payload = mapPayload(req);
        const errors = await validatePayload(payload, 'update');
        if (errors.length) {
            setFlash(req, 'error', errors[0]);
            return res.redirect('/admin/promotions');
        }

        const duplicate = await Promotion.findOne({ code: payload.code, _id: { $ne: id } }).lean();
        if (duplicate) {
            setFlash(req, 'error', `Mã khuyến mãi "${payload.code}" đã tồn tại.`);
            return res.redirect('/admin/promotions');
        }

        const now = new Date();
        const lifecycleStatus = toLifecycleStatus(payload.status, payload.startAt, payload.endAt, now);

        promotion.code = payload.code;
        promotion.name = payload.name;
        promotion.description = payload.description;
        promotion.discountType = payload.discountType;
        promotion.discountValue = payload.discountValue;
        promotion.maxDiscountValue = payload.maxDiscountValue;
        promotion.minOrderValue = payload.minOrderValue;
        promotion.applyScope = payload.applyScope;
        promotion.routeId = payload.routeId;
        promotion.startAt = payload.startAt;
        promotion.endAt = payload.endAt;
        promotion.status = lifecycleStatus;
        promotion.usageLimitTotal = payload.usageLimitTotal;
        promotion.usageLimitPerUser = payload.usageLimitPerUser;
        promotion.updatedBy = req.session.userId || null;

        if (lifecycleStatus !== 'ENDED') {
            promotion.endedEarlyAt = null;
        }

        await promotion.save();

        setFlash(req, 'success', `Đã cập nhật chương trình "${promotion.name}" thành công.`);
        return res.redirect('/admin/promotions');
    } catch (err) {
        console.error('updatePromotion error:', err);
        if (err.code === 11000) {
            setFlash(req, 'error', 'Mã khuyến mãi đã tồn tại.');
            return res.redirect('/admin/promotions');
        }
        setFlash(req, 'error', 'Có lỗi xảy ra khi cập nhật chương trình khuyến mãi.');
        return res.redirect('/admin/promotions');
    }
};

exports.endPromotionEarly = async (req, res) => {
    try {
        const { id } = req.params;
        const promotion = await Promotion.findById(id);
        if (!promotion) {
            setFlash(req, 'error', 'Không tìm thấy chương trình cần kết thúc sớm.');
            return res.redirect('/admin/promotions');
        }

        if (promotion.status === 'ENDED' || promotion.status === 'CANCELLED') {
            setFlash(req, 'error', 'Chương trình này đã kết thúc trước đó.');
            return res.redirect('/admin/promotions');
        }

        const now = new Date();
        promotion.status = 'ENDED';
        promotion.endAt = now;
        promotion.endedEarlyAt = now;
        promotion.updatedBy = req.session.userId || null;

        await promotion.save();

        setFlash(req, 'success', `Đã kết thúc sớm chương trình "${promotion.name}".`);
        return res.redirect('/admin/promotions');
    } catch (err) {
        console.error('endPromotionEarly error:', err);
        setFlash(req, 'error', 'Không thể kết thúc sớm chương trình này.');
        return res.redirect('/admin/promotions');
    }
};
