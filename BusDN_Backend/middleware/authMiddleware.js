const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    try {
        const token = req.header('Authorization').replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'Authentication failed' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
        req.user = decoded; // { userId, role, ... }
        next();
    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
};
