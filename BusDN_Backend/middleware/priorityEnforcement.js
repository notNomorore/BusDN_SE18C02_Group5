const { applyPriorityExpiryForUser } = require('../utils/priorityUtils');

const enforcePriorityExpiry = async (req, res, next) => {
    try {
        if (!req.session?.userId) {
            return next();
        }
        await applyPriorityExpiryForUser(req.session.userId);
        return next();
    } catch (error) {
        console.error('Priority enforcement middleware error:', error);
        return next();
    }
};

module.exports = {
    enforcePriorityExpiry
};
