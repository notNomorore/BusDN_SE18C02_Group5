require('dotenv').config(); // Luôn đặt đầu tiên để nạp .env
const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const connectDB = require('./config/connectdb');

// --- 1. IMPORT CONFIGURATIONS ---
const configViewEngine = require('./config/viewEngine');
const configPassport = require('./config/passport');
const { upload, priorityProfileUpload } = require('./config/multer');

// --- 2. SETUP EXPRESS APP ---
const app = express();

// --- 3. DATABASE CONNECTION ---
connectDB(); // Sử dụng hàm connect từ config/database.js của bạn

// --- 4. MIDDLEWARE (Tối ưu từ cả hai nhánh) ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || "my_secret_key",
    resave: false,
    saveUninitialized: false,
}));

// SETUP VIEW ENGINE & PASSPORT
configViewEngine(app);
configPassport(app); // Chỗ này đã bao gồm passport.initialize() và session()

// --- 5. ROUTES CONFIGURATION ---
// Import các router đã được tách file (Giữ cấu trúc sạch của bạn)
const webRoutes = require('./routes/webRoutes')(upload);
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const passengerRoutes = require('./routes/passengerRoutes');
const priorityRoutes = require('./routes/priorityRoutes')(priorityProfileUpload);

// Web routes (home, login, register, profile, lookup, etc.)
app.use('/', webRoutes);

// Priority profile routes (user and admin)
app.use('/priority', priorityRoutes);

// Admin routes (require isAdmin middleware)
app.use('/admin', adminRoutes);

// API routes cho mobile
app.use('/api/auth', authRoutes);

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
            res.redirect('/home');
        } else {
            res.redirect('/login');
        }
    }
);

// --- 7. ROOT REDIRECT ---
app.get('/', (req, res) => {
    if (!req.session.userId) return res.redirect("/login");
    if (req.session.role === "ADMIN") return res.redirect("/admin/dashboard");
    return res.redirect('/home');
});

// --- 8. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server chạy tại: http://localhost:${PORT}`));