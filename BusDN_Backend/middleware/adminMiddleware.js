const { User } = require('../models/models');

// Middleware check if user is admin via session
const isAdmin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    if (req.session.role !== 'ADMIN') {
        return res.redirect('/profile');
    }
    next();
};

const isFinanceOrAdmin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    if (!['ADMIN', 'FINANCE'].includes(req.session.role)) {
        return res.redirect('/profile');
    }
    next();
};

module.exports = { isAdmin, isFinanceOrAdmin };
