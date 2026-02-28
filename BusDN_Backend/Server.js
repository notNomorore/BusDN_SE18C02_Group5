const express = require('express');
const multer = require('multer');
const path = require('path');
const connectDB = require('./config/connectdb');
// --- 1. IMPORT CONFIGURATIONS ---
const configViewEngine = require('./config/viewEngine');
const configPassport = require('./config/passport');
const { upload, priorityProfileUpload } = require('./config/multer');

// --- 2. SETUP EXPRESS APP ---
const app = express();

// --- 3. SETUP VIEW ENGINE & MIDDLEWARE ---
configViewEngine(app);
configPassport(app);

// --- 4. MONGODB CONNECTION ---
connectDB();
// --- 5. ROUTES CONFIGURATION ---
const webRoutes = require('./routes/webRoutes')(upload);
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const priorityRoutes = require('./routes/priorityRoutes')(priorityProfileUpload);

// Web routes (home, login, register, profile, etc.)
app.use('/', webRoutes);

// Priority profile routes (user and admin)
app.use('/priority', priorityRoutes);

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