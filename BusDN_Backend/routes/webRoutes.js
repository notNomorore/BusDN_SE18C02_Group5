const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { User } = require('../models/models');
const router = express.Router();
const { checkPassword, PASS_ERR_MSG, sendEmail } = require('../config/helpers');
const { getAllRoutes, getRouteDetail, getRouteGeoJSON } = require('../controllers/routeController');
require('dotenv').config();

module.exports = (upload) => {


    // --- HOME ROUTE ---
    router.get('/home', async (req, res) => {
        let user = null;
        if (req.session.userId) {
            user = await User.findById(req.session.userId);
        }
        res.render('home', { user });
    });

    // --- LOGIN & REGISTER ---
    router.get('/login', (req, res) => {
        res.render('login', { error: null, success: null });
    });

    router.post('/login', async (req, res) => {
        try {
            const { email, password } = req.body;
            const user = await User.findOne({ email });

            if (!user || !(await bcrypt.compare(password, user.password))) {
                return res.render('login', { error: 'Sai email hoặc mật khẩu!', success: null });
            }
            if (!user.isVerified) {
                return res.render('login', { error: 'Tài khoản chưa xác thực email!', success: null });
            }
            if (user.isLocked) {
                return res.render('login', { error: 'Tài khoản của bạn đã bị khóa do vi phạm. Vui lòng liên hệ Admin!', success: null });
            }

            req.session.userId = user._id;
            req.session.role = user.role;

            if (user.role === 'ADMIN') return res.redirect('/admin/dashboard');
            if (user.role === 'PASSENGER') return res.redirect('/home');
            return res.redirect('/profile');
        } catch (err) {
            res.render('login', { error: 'Lỗi hệ thống', success: null });
        }
    });

    router.post('/register', async (req, res) => {
        try {
            const { email, password } = req.body;

            if (!checkPassword(password)) {
                return res.render('login', { error: PASS_ERR_MSG, success: null });
            }

            const existingUser = await User.findOne({ email });
            if (existingUser) return res.render('login', { error: 'Email đã tồn tại!', success: null });

            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            const newUser = new User({
                email,
                password: hashedPassword,
                role: 'PASSENGER',
                fullName: 'Hành khách mới',
                isVerified: false
            });
            await newUser.save();

            const verifyLink = `http://localhost:3000/verify/${newUser._id}`;
            await sendEmail(email, 'Xác thực tài khoản BusDN',
                `<p>Chào mừng!</p><p>Vui lòng bấm link để xác thực: <a href="${verifyLink}">${verifyLink}</a></p>`
            );

            res.render('login', { error: null, success: 'Đăng ký thành công! Vui lòng kiểm tra Email để xác thực.' });
        } catch (err) {
            console.log(err);
            res.render('login', { error: 'Lỗi hệ thống', success: null });
        }
    });

    // --- EMAIL VERIFICATION ---
    router.get('/verify/:userId', async (req, res) => {
        try {
            const user = await User.findById(req.params.userId);
            if (!user) return res.send('<h1>❌ Link không hợp lệ!</h1>');
            if (user.isVerified) return res.send('<h1>✅ Đã xác thực rồi! <a href="/login">Đăng nhập</a></h1>');

            await User.findByIdAndUpdate(req.params.userId, { isVerified: true });
            res.send(`<h1>✅ Xác thực thành công!</h1><p><a href="/login">Đăng nhập ngay</a></p>`);
        } catch (err) {
            res.send('<h1>❌ Lỗi hệ thống!</h1>');
        }
    });

    // --- FORGOT PASSWORD ---
    router.get('/forgot-password', (req, res) => res.render('forgot-password'));

    router.post('/forgot-password', async (req, res) => {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.send('<h1>Đã gửi email khôi phục (Nếu tài khoản tồn tại). <a href="/login">Quay lại</a></h1>');

        const resetLink = `http://localhost:3000/reset-password/${user._id}`;
        await sendEmail(email, 'Khôi phục mật khẩu BusDN',
            `<p>Bấm vào đây để đặt lại mật khẩu: <a href="${resetLink}">${resetLink}</a></p>`
        );

        res.send('<h1>Đã gửi mail hướng dẫn! Kiểm tra hộp thư đến. <a href="/login">Quay lại</a></h1>');
    });

    // --- RESET PASSWORD ---
    router.get('/reset-password/:userId', async (req, res) => {
        try {
            const user = await User.findById(req.params.userId);
            if (!user) return res.send('<h1>❌ Link hỏng!</h1>');
            res.render('reset-password', { userId: user._id });
        } catch (err) {
            res.send('<h1>❌ Lỗi hệ thống!</h1>');
        }
    });

    router.post('/reset-password/:userId', async (req, res) => {
        try {
            const { password, confirmPassword } = req.body;

            if (!checkPassword(password)) {
                return res.render('reset-password', { userId: req.params.userId, error: PASS_ERR_MSG });
            }

            if (password !== confirmPassword) {
                return res.render('reset-password', { userId: req.params.userId, error: 'Mật khẩu không khớp!' });
            }
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            await User.findByIdAndUpdate(req.params.userId, { password: hashedPassword });

            res.send(`<h1>✅ Đặt lại mật khẩu thành công! <a href="/login">Đăng nhập</a></h1>`);
        } catch (err) {
            res.send('<h1>❌ Lỗi hệ thống!</h1>');
        }
    });

    // --- LOGOUT ---
    router.get('/logout', (req, res) => {
        req.session.destroy();
        res.redirect('/login');
    });

    // --- PROFILE ---
    // webRoutes.js - Khoảng dòng 186
    router.get('/profile', async (req, res) => {
        if (!req.session.userId) return res.redirect('/login');

        try {
            const user = await User.findById(req.session.userId); // Lấy data từ DB

            const error = req.query.error;
            const success = req.query.success;

            // ĐỔI req.user THÀNH user
            res.render('profile', { user: user, error, success });
        } catch (err) {
            console.error(err);
            res.redirect('/home');
        }
    });

    // --- UPLOAD AVATAR ---
    router.post('/upload-avatar', upload.single('avatar'), async (req, res) => {
        if (!req.session.userId) return res.redirect('/login');
        if (req.file) {
            await User.findByIdAndUpdate(req.session.userId, { avatar: '/uploads/' + req.file.filename });
        }
        if (req.session.role === 'ADMIN') return res.redirect('/admin/profile');
        return res.redirect('/profile');
    });

    // --- EDIT PROFILE ---
    router.post('/edit-profile', async (req, res) => {
        if (!req.session.userId) return res.redirect('/login');
        await User.findByIdAndUpdate(req.session.userId, {
            fullName: req.body.fullName,
            phone: req.body.phone
        });

        if (req.session.role === 'ADMIN') return res.redirect('/admin/profile');
        if (req.session.role === 'PASSENGER') return res.redirect('/home');
        return res.redirect('/profile');
    });

    // --- CHANGE PASSWORD ---
    router.post('/change-password', async (req, res) => {
        if (!req.session.userId) return res.redirect('/login');
        const { oldPassword, newPassword, confirmPassword } = req.body;
        const user = await User.findById(req.session.userId);

        if (!checkPassword(newPassword)) {
            return res.redirect('/profile?error=' + encodeURIComponent(PASS_ERR_MSG));
        }

        if (newPassword !== confirmPassword) {
            return res.redirect('/profile?error=' + encodeURIComponent('Mật khẩu mới không khớp!'));
        }

        if (!(await bcrypt.compare(oldPassword, user.password))) {
            return res.redirect('/profile?error=' + encodeURIComponent('Mật khẩu cũ không đúng!'));
        }

        const hashedPassword = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
        await User.findByIdAndUpdate(req.session.userId, { password: hashedPassword });

        return res.redirect('/profile?success=' + encodeURIComponent('Đổi mật khẩu thành công!'));
    });

    // --- ROUTE LOOKUP PAGE ---
    router.get('/route-lookup', (req, res) => {
        res.render('route-lookup');
    });

    // --- PUBLIC API ROUTES (NO AUTHENTICATION) ---
    // Get all routes with optional search filter
    router.get('/api/public/routes', getAllRoutes);

    // Get detailed route information with stops
    router.get('/api/public/routes/:routeId', getRouteDetail);

    // Get route GeoJSON data for map display
    router.get('/api/public/routes/:routeId/geojson', getRouteGeoJSON);

    return router;

};