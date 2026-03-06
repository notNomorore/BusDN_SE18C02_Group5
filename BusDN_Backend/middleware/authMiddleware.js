const jwt = require('jsonwebtoken');
const { User } = require('../models/models');
const { applyPriorityExpiryForUser } = require('../utils/priorityUtils');

module.exports = (req, res, next) => {
    try {
        const token = req.header('Authorization').replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'Authentication failed' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
        req.user = decoded; // { userId, role, ... }

        User.findById(decoded.userId).select('isFirstLogin')
            .then(async (user) => {
                if (!user) {
                    return res.status(401).json({ message: 'Invalid token' });
                }
                const allowChangePassword = req.path.includes('/change-password');
                if (user.isFirstLogin && !allowChangePassword) {
                    return res.status(403).json({
                        message: 'First login requires password change',
                        requiresPasswordChange: true
                    });
                }
                await applyPriorityExpiryForUser(decoded.userId);
                return next();
            })
            .catch(() => res.status(401).json({ message: 'Invalid token' }));
    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
};
