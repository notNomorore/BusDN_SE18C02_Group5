const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');

// --- 1. IMPORT CONFIGURATIONS ---
const configViewEngine = require('./config/viewEngine');
const configPassport = require('./config/passport');
const { upload } = require('./config/multer');

// --- 2. SETUP EXPRESS APP ---
const app = express();

// --- 3. SETUP VIEW ENGINE & MIDDLEWARE ---
configViewEngine(app);
configPassport(app);

// --- 4. MONGODB CONNECTION ---
mongoose.connect('mongodb+srv://DE181046:nhatminh@busdn.2y1qib0.mongodb.net/?appName=BusDN')
    .then(() => console.log("✅ Đã kết nối MongoDB Atlas"))
    .catch(err => console.error("❌ Lỗi kết nối DB:", err));

// --- 5. ROUTES CONFIGURATION ---
const webRoutes = require('./routes/webRoutes')(upload);
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');

// Web routes (home, login, register, profile, etc.)
app.use('/', webRoutes);

// Admin routes (require isAdmin middleware)
app.use('/admin', adminRoutes);
app.use('/admin/staff', adminRoutes); // Ensure staff management routes are included under /admin/staff
// API routes for mobile
app.use('/api/auth', authRoutes);

// --- GOOGLE AUTH ROUTES ---
const passport = require('passport');
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    async (req, res) => {
        req.session.userId = req.user._id;
        req.session.role = req.user.role;
        res.redirect('/home');
    }
);

// --- 6. ROOT REDIRECT ---
app.get('/', (req, res) => {
    res.redirect('/home');
});

// --- 7. START SERVER ---
app.listen(3000, () => console.log('🚀 Server chạy tại: http://localhost:3000'));