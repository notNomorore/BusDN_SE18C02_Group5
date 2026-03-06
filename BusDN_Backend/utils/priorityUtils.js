const { User, PriorityProfile } = require('../models/models');
const { getIO } = require('../config/socket');

const PRIORITY_DISCOUNT_RATE = 0.2;
const PRIORITY_MIN_YEARS = 2;

const getMinPriorityExpiryDate = (baseDate = new Date()) => {
    const minDate = new Date(baseDate);
    minDate.setFullYear(minDate.getFullYear() + PRIORITY_MIN_YEARS);
    minDate.setHours(0, 0, 0, 0);
    return minDate;
};

const normalizeDateOnly = (dateValue) => {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
};

const isExpiryDateValid = (expiryDate, approvalDate = new Date()) => {
    const normalizedExpiry = normalizeDateOnly(expiryDate);
    if (!normalizedExpiry) return false;
    const minDate = getMinPriorityExpiryDate(approvalDate);
    return normalizedExpiry.getTime() >= minDate.getTime();
};

const applyPriorityDiscount = (price, user) => {
    const amount = Number(price || 0);
    if (!Number.isFinite(amount) || amount < 0) return 0;
    if (!user?.isPriorityGroup) return amount;
    return amount * (1 - PRIORITY_DISCOUNT_RATE);
};

const getPendingPriorityCount = async () => PriorityProfile.countDocuments({ status: 'pending' });

const emitPendingPriorityCount = async () => {
    const io = getIO();
    if (!io) return;
    const pendingCount = await getPendingPriorityCount();
    io.to('admins').emit('priority:pending-count', { pendingCount });
};

const applyPriorityExpiryForUser = async (userId) => {
    if (!userId) return null;
    const user = await User.findById(userId);
    if (!user) return null;

    const expiryDate = user?.priorityProfile?.expiryDate ? new Date(user.priorityProfile.expiryDate) : null;
    const shouldExpire =
        !!expiryDate &&
        !Number.isNaN(expiryDate.getTime()) &&
        new Date() > expiryDate &&
        (user.isPriorityGroup || user.priorityStatus === 'APPROVED');

    if (!shouldExpire) {
        return user;
    }

    user.isPriorityGroup = false;
    user.priorityStatus = 'EXPIRED';
    user.priorityProfile = {
        ...(user.priorityProfile || {}),
        status: 'EXPIRED',
        expiryDate
    };
    await user.save();

    return user;
};

module.exports = {
    PRIORITY_DISCOUNT_RATE,
    PRIORITY_MIN_YEARS,
    getMinPriorityExpiryDate,
    isExpiryDateValid,
    applyPriorityDiscount,
    getPendingPriorityCount,
    emitPendingPriorityCount,
    applyPriorityExpiryForUser
};
