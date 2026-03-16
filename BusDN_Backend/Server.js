require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const connectDB = require('./config/connectdb');
const models = require("./models/models");
const { Route, Schedule, User } = models;
// --- 1. IMPORT CONFIGURATIONS ---
const configViewEngine = require('./config/viewEngine');
const configPassport = require('./config/passport');
const { upload, priorityProfileUpload } = require('./config/multer');
const { setIO } = require('./config/socket');
const { enforcePriorityExpiry } = require('./middleware/priorityEnforcement');

// --- 2. SETUP EXPRESS APP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});
setIO(io);

// --- 3. DATABASE CONNECTION ---
connectDB(); 

// --- 4. MIDDLEWARE (Tối ưu từ cả hai nhánh) ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || "my_secret_key",
    resave: false,
    saveUninitialized: false,
}));

io.on('connection', (socket) => {
    socket.on('admin:join', () => {
        socket.join('admins');
    });

    socket.on('auth:join', ({ token }) => {
        try {
            if (!token || typeof token !== 'string') return;
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
            if (!decoded?.userId || !decoded?.role) return;

            socket.join(`user:${decoded.userId}`);
            socket.join(`role:${decoded.role}`);
        } catch (err) {
            // ignore invalid token
        }
    });
});

// SETUP VIEW ENGINE & PASSPORT
configViewEngine(app);
configPassport(app); // Chỗ này đã bao gồm passport.initialize() và session()

// Make current user available in all EJS templates.
app.use(async (req, res, next) => {
    res.locals.user = null;

    if (!req.session || !req.session.userId) {
        return next();
    }

    try {
        res.locals.user = await User.findById(req.session.userId).lean();
    } catch (error) {
        console.error('User locals middleware error:', error);
    }

    return next();
});

app.use(enforcePriorityExpiry);

app.use(async (req, res, next) => {
    try {
        if (!req.session || !req.session.userId) return next();

        const bypassPaths = [
            '/change-password',
            '/logout',
            '/login',
            '/register',
            '/forgot-password',
            '/verify-otp',
            '/reset-password',
            '/resend-otp'
        ];
        const bypassPrefix = ['/api', '/auth', '/uploads', '/images'];

        if (bypassPaths.includes(req.path) || bypassPrefix.some((p) => req.path.startsWith(p))) {
            return next();
        }

        const user = await User.findById(req.session.userId).select('isFirstLogin');
        if (user && user.isFirstLogin) {
            return res.redirect('/change-password?firstLogin=1');
        }
        return next();
    } catch (error) {
        console.error('First-login middleware error:', error);
        return next();
    }
});

// --- 5. ROUTES CONFIGURATION ---
// Import các router đã được tách file 
const webRoutes = require('./routes/webRoutes')(upload);
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const passengerRoutes = require('./routes/passengerRoutes');
const priorityRoutes = require('./routes/priorityRoutes')(priorityProfileUpload);
const apiRoutes = require('./routes/apiRoutes');

// Web routes (home, login, register, profile, lookup, etc.)
app.use('/', webRoutes);

// Priority profile routes (user and admin)
app.use('/priority', priorityRoutes);

// Admin routes (require isAdmin middleware)
app.use('/admin', adminRoutes);

// API routes cho mobile
app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);

// Passenger routes (UC13: Wallet/Deposit của anh Trí)
app.use('/passenger', passengerRoutes);

// --- 6. GOOGLE AUTH ROUTES (Giữ logic redirect chuẩn) ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    async (req, res) => {
        if (req.user) {
            req.session.userId = req.user._id;
            req.session.role = req.user.role;
            return res.redirect('/home');
        }
        return res.redirect('/login');
    }
);
// --- 7. ROOT ROUTE ---
app.get('/', (req, res) => {
    return res.render('home', { user: res.locals.user || null });
});
// --- 8. START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server chạy tại: http://localhost:${PORT}`));
