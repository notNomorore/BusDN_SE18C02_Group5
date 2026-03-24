const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { User, PhoneVerification } = require('../models/models');
const router = express.Router();
const { checkPassword, PASS_ERR_MSG, sendEmail, generateOTP, generateResetToken } = require('../config/helpers');
const { getAllRoutes, getRouteDetail, getRouteGeoJSON, getRouteLiveVehicles } = require('../controllers/routeController');
const { applyPriorityExpiryForUser } = require('../utils/priorityUtils');
require('dotenv').config();

const getFirebaseConfig = () => ({
    apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyCk3qOQnxRP9Lphy-aPUDF1e0VUSs6Fs9U',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'busdn-se18c02.firebaseapp.com',
    projectId: process.env.FIREBASE_PROJECT_ID || 'busdn-se18c02',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'busdn-se18c02.firebasestorage.app',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '24020218217',
    appId: process.env.FIREBASE_APP_ID || '1:24020218217:web:7653e48a118ddaa633cdf8',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-4HZF53NLNW'
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizePhone = (value) => (value || '').toString().trim().replace(/[\s.-]/g, '');
const detectContactType = (value) => (value.includes('@') ? 'EMAIL' : 'PHONE');
const isValidPhone = (value) => /^\+?\d{9,15}$/.test(value);
const getRegData = (req) => (req.session.regData || {});
const setRegData = (req, patch) => {
    req.session.regData = { ...getRegData(req), ...patch };
};

module.exports = (upload) => {


    // --- HOME ROUTE ---
    router.get('/home', async (req, res) => {
        let user = null;
        if (req.session.userId) {
            user = await User.findById(req.session.userId);
        }
        return res.render('home', { user });
    });

    // --- LOGIN ---
    router.get('/login', (req, res) => {
        return res.render('admin/login', { error: req.query.error || null, success: req.query.success || null });
    });

    router.post('/login', async (req, res) => {
        try {
            const identifier = (req.body.email || '').trim();
            const { password } = req.body;
            const user = await User.findOne({
                $or: [
                    { email: identifier.toLowerCase() },
                    { phone: identifier }
                ]
            });

            if (!user || !(await bcrypt.compare(password, user.password))) {
                return res.render('admin/login', { error: 'Sai email hoặc mật khẩu!', success: null });
            }
            if (!user.isVerified) {
                return res.render('admin/login', { error: 'Tài khoản chưa xác thực email!', success: null });
            }
            if (user.isLocked || user.status === 'LOCKED') {
                return res.render('admin/login', { error: 'Tài khoản của bạn đã bị khóa do vi phạm. Vui lòng liên hệ Admin!', success: null });
            }

            await applyPriorityExpiryForUser(user._id);

            req.session.userId = user._id;
            req.session.role = user.role;

            if (user.isFirstLogin) {
                return res.redirect('/change-password?firstLogin=1');
            }

            if (user.role === 'ADMIN') return res.redirect('/admin/dashboard');
            if (user.role === 'FINANCE') return res.redirect('/admin/fares');
            if (user.role === 'PASSENGER') return res.redirect('/home');
            return res.redirect('/profile');
        } catch (err) {
            return res.render('admin/login', { error: 'Lỗi hệ thống', success: null });
        }
    });

    // --- REGISTRATION FLOW (4 STEPS) ---
    router.get('/register', (req, res) => {
        return res.redirect('/register-step1');
    });

    router.get('/register-step1', (req, res) => {
        const regData = getRegData(req);
        return res.render('register-step1', {
            error: req.query.error || null,
            fullName: regData.fullName || ''
        });
    });

    router.post('/register-step1', (req, res) => {
        const fullName = (req.body.fullName || '').trim();
        if (!fullName) {
            return res.render('register-step1', { error: 'Vui lòng nhập họ tên.', fullName: '' });
        }
        setRegData(req, { fullName });
        return res.redirect('/register-step2');
    });

    router.get('/register-step2', (req, res) => {
        const regData = getRegData(req);
        if (!regData.fullName) return res.redirect('/register-step1');
        return res.render('register-step2', {
            error: req.query.error || null,
            success: req.query.success || null,
            contactValue: regData.contactValue || '',
            firebaseConfig: getFirebaseConfig()
        });
    });

    router.post('/register-step2/check-contact', async (req, res) => {
        try {
            const raw = (req.body.contactValue || '').trim();
            if (!raw) return res.status(400).json({ ok: false, message: 'Thiếu dữ liệu liên hệ.' });
            const contactType = detectContactType(raw);

            if (contactType === 'EMAIL') {
                const email = raw.toLowerCase();
                if (!EMAIL_REGEX.test(email)) return res.status(400).json({ ok: false, message: 'Email không hợp lệ.' });
                const existing = await User.findOne({ email });
                if (existing) return res.status(400).json({ ok: false, message: 'Email đã tồn tại.' });
                return res.json({ ok: true, contactType, normalized: email });
            }

            const phone = normalizePhone(raw);
            if (!isValidPhone(phone)) return res.status(400).json({ ok: false, message: 'Số điện thoại không hợp lệ.' });
            const existing = await User.findOne({ phone });
            if (existing) return res.status(400).json({ ok: false, message: 'Số điện thoại đã tồn tại.' });
            return res.json({ ok: true, contactType, normalized: phone });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ ok: false, message: 'Lỗi hệ thống.' });
        }
    });

    router.post('/register-step2/phone-verify', async (req, res) => {
        try {
            const regData = getRegData(req);
            if (!regData.fullName) return res.status(400).json({ ok: false, message: 'Thiếu bước 1.' });

            const phone = normalizePhone(req.body.phone);
            const firebaseUid = (req.body.firebaseUid || '').trim() || null;
            if (!isValidPhone(phone)) return res.status(400).json({ ok: false, message: 'Số điện thoại không hợp lệ.' });

            const existingUser = await User.findOne({ phone });
            if (existingUser) return res.status(400).json({ ok: false, message: 'Số điện thoại đã tồn tại.' });

            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
            await PhoneVerification.findOneAndUpdate(
                { phone },
                { phone, firebaseUid, verifiedAt: new Date(), expiresAt, consumed: false },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            setRegData(req, {
                contactType: 'PHONE',
                contactValue: phone,
                phoneVerified: true,
                contactVerified: false
            });

            return res.json({ ok: true, redirectTo: '/verify-otp?type=registration&method=phone' });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ ok: false, message: 'Lỗi hệ thống khi lưu số điện thoại.' });
        }
    });

    router.post('/register-step2', async (req, res) => {
        try {
            const regData = getRegData(req);
            if (!regData.fullName) return res.redirect('/register-step1');

            const contactValueRaw = (req.body.contactValue || '').trim();
            if (!contactValueRaw) {
                return res.render('register-step2', {
                    error: 'Vui lòng nhập Email hoặc Số điện thoại.',
                    success: null,
                    contactValue: '',
                    firebaseConfig: getFirebaseConfig()
                });
            }

            const contactType = detectContactType(contactValueRaw);
            if (contactType === 'PHONE') {
                return res.render('register-step2', {
                    error: 'Vui lòng xác thực số điện thoại bằng Firebase ở bước này.',
                    success: null,
                    contactValue: contactValueRaw,
                    firebaseConfig: getFirebaseConfig()
                });
            }

            const email = contactValueRaw.toLowerCase();
            if (!EMAIL_REGEX.test(email)) {
                return res.render('register-step2', {
                    error: 'Email không hợp lệ.',
                    success: null,
                    contactValue: contactValueRaw,
                    firebaseConfig: getFirebaseConfig()
                });
            }

            const existingEmail = await User.findOne({ email });
            if (existingEmail) {
                return res.render('register-step2', {
                    error: 'Email đã tồn tại.',
                    success: null,
                    contactValue: contactValueRaw,
                    firebaseConfig: getFirebaseConfig()
                });
            }

            const otp = generateOTP();
            const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

            setRegData(req, {
                contactType: 'EMAIL',
                contactValue: email,
                otpCode: otp,
                otpExpires,
                contactVerified: false
            });

            await sendEmail(
                email,
                'BusDN - Mã OTP xác thực đăng ký',
                `<p>Mã OTP của bạn là: <strong>${otp}</strong>. Hiệu lực trong 10 phút.</p>`
            );
            return res.redirect('/verify-otp?type=registration');
        } catch (error) {
            console.error(error);
            return res.render('register-step2', {
                error: 'Lỗi hệ thống.',
                success: null,
                contactValue: req.body.contactValue || '',
                firebaseConfig: getFirebaseConfig()
            });
        }
    });

    // --- OTP VERIFICATION PAGE ---
    router.get('/verify-otp', (req, res) => {
        const type = req.query.type || 'registration';
        const method = req.query.method || 'email';

        if (type === 'registration') {
            const regData = getRegData(req);
            if (!regData.fullName || !regData.contactType || !regData.contactValue) {
                return res.redirect('/register-step1');
            }

            const isPhoneFlow = regData.contactType === 'PHONE' || method === 'phone';
            const phoneVerified = !!regData.phoneVerified;
            return res.render('verify-otp', {
                email: regData.contactValue,
                type: isPhoneFlow ? 'registration-phone' : 'registration',
                error: null,
                success: null,
                isPhoneFlow,
                phoneVerified
            });
        }

        const email = req.query.email;
        if (!email) return res.redirect('/login');
        return res.render('verify-otp', {
            email,
            type,
            error: null,
            success: null,
            isPhoneFlow: false,
            phoneVerified: false
        });
    });

    // --- VERIFY OTP ---
    router.post('/verify-otp', async (req, res) => {
        try {
            const { email, otp, type } = req.body;

            if (type === 'registration') {
                const regData = getRegData(req);
                if (!regData.contactValue || regData.contactType !== 'EMAIL') {
                    return res.redirect('/register-step1');
                }
                if (!regData.otpCode || regData.otpCode !== otp) {
                    return res.render('verify-otp', {
                        email: regData.contactValue,
                        type: 'registration',
                        error: 'Mã OTP không đúng!',
                        success: null,
                        isPhoneFlow: false,
                        phoneVerified: false
                    });
                }
                if (new Date() > new Date(regData.otpExpires)) {
                    return res.render('verify-otp', {
                        email: regData.contactValue,
                        type: 'registration',
                        error: 'Mã OTP đã hết hạn!',
                        success: null,
                        isPhoneFlow: false,
                        phoneVerified: false
                    });
                }

                setRegData(req, { contactVerified: true, otpCode: null, otpExpires: null });
                return res.redirect('/create-password');
            }

            if (type === 'registration-phone') {
                const regData = getRegData(req);
                if (!regData.contactValue || regData.contactType !== 'PHONE' || !regData.phoneVerified) {
                    return res.redirect('/register-step2?error=' + encodeURIComponent('Vui lòng xác thực số điện thoại trước.'));
                }
                setRegData(req, { contactVerified: true });
                return res.redirect('/create-password');
            }

            const user = await User.findOne({ email });
            if (!user) {
                return res.render('verify-otp', {
                    email,
                    type: type || 'registration',
                    error: 'Email không tồn tại!',
                    success: null,
                    isPhoneFlow: false,
                    phoneVerified: false
                });
            }
            if (!user.otp_code || user.otp_code !== otp) {
                return res.render('verify-otp', {
                    email,
                    type: type || 'registration',
                    error: 'Mã OTP không đúng!',
                    success: null,
                    isPhoneFlow: false,
                    phoneVerified: false
                });
            }
            if (new Date() > user.otp_expires) {
                return res.render('verify-otp', {
                    email,
                    type: type || 'registration',
                    error: 'Mã OTP đã hết hạn!',
                    success: null,
                    isPhoneFlow: false,
                    phoneVerified: false
                });
            }

            if (type === 'forgot-password') {
                const resetToken = generateResetToken();
                await User.findByIdAndUpdate(user._id, {
                    resetToken,
                    otp_code: null,
                    otp_expires: null
                });
                return res.redirect(`/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`);
            }

            return res.redirect('/login');
        } catch (err) {
            console.error(err);
            return res.render('verify-otp', {
                email: req.body.email,
                type: req.body.type || 'registration',
                error: 'Lỗi hệ thống',
                success: null,
                isPhoneFlow: req.body.type === 'registration-phone',
                phoneVerified: req.body.type === 'registration-phone'
            });
        }
    });

    // --- STEP 4: CREATE PASSWORD ---
    router.get('/create-password', (req, res) => {
        const regData = getRegData(req);
        if (!regData.fullName || !regData.contactValue || !regData.contactVerified) {
            return res.redirect('/register-step1');
        }
        return res.render('create-password', {
            error: req.query.error || null,
            fullName: regData.fullName,
            contactType: regData.contactType,
            contactValue: regData.contactValue
        });
    });

    router.post('/create-password', async (req, res) => {
        try {
            const regData = getRegData(req);
            if (!regData.fullName || !regData.contactValue || !regData.contactVerified) {
                return res.redirect('/register-step1');
            }

            const { password, confirmPassword } = req.body;
            if (!password || !confirmPassword) {
                return res.render('create-password', {
                    error: 'Vui lòng nhập đầy đủ mật khẩu.',
                    fullName: regData.fullName,
                    contactType: regData.contactType,
                    contactValue: regData.contactValue
                });
            }
            if (!checkPassword(password)) {
                return res.render('create-password', {
                    error: PASS_ERR_MSG,
                    fullName: regData.fullName,
                    contactType: regData.contactType,
                    contactValue: regData.contactValue
                });
            }
            if (password !== confirmPassword) {
                return res.render('create-password', {
                    error: 'Mật khẩu xác nhận không khớp.',
                    fullName: regData.fullName,
                    contactType: regData.contactType,
                    contactValue: regData.contactValue
                });
            }

            const userPayload = {
                fullName: regData.fullName,
                role: 'PASSENGER',
                isFirstLogin: false,
                isVerified: true
            };
            if (regData.contactType === 'EMAIL') userPayload.email = regData.contactValue;
            if (regData.contactType === 'PHONE') userPayload.phone = regData.contactValue;

            const existingByEmail = userPayload.email ? await User.findOne({ email: userPayload.email }) : null;
            if (existingByEmail) {
                return res.render('create-password', {
                    error: 'Email đã tồn tại.',
                    fullName: regData.fullName,
                    contactType: regData.contactType,
                    contactValue: regData.contactValue
                });
            }
            const existingByPhone = userPayload.phone ? await User.findOne({ phone: userPayload.phone }) : null;
            if (existingByPhone) {
                return res.render('create-password', {
                    error: 'Số điện thoại đã tồn tại.',
                    fullName: regData.fullName,
                    contactType: regData.contactType,
                    contactValue: regData.contactValue
                });
            }

            const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
            userPayload.password = hashedPassword;
            await User.create(userPayload);

            if (userPayload.phone) {
                await PhoneVerification.updateOne(
                    { phone: userPayload.phone, consumed: false },
                    { $set: { consumed: true } }
                );
            }

            req.session.regData = null;
            return res.redirect('/login?success=' + encodeURIComponent('Đăng ký thành công, vui lòng đăng nhập.'));
        } catch (error) {
            console.error(error);
            const regData = getRegData(req);
            return res.render('create-password', {
                error: 'Lỗi hệ thống.',
                fullName: regData.fullName || '',
                contactType: regData.contactType || '',
                contactValue: regData.contactValue || ''
            });
        }
    });

    // --- RESEND OTP ---
    router.post('/resend-otp', async (req, res) => {
        try {
            const { email, type } = req.body;

            if (type === 'registration') {
                const regData = getRegData(req);
                if (!regData.contactValue || regData.contactType !== 'EMAIL') {
                    return res.json({ success: false, message: 'Phiên đăng ký không hợp lệ.' });
                }
                const otp = generateOTP();
                const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
                setRegData(req, { otpCode: otp, otpExpires });
                await sendEmail(regData.contactValue, 'Mã OTP mới - BusDN', `<p>Mã OTP mới của bạn: <strong>${otp}</strong></p>`);
                return res.json({ success: true, message: 'Mã OTP mới đã được gửi!' });
            }

            const user = await User.findOne({ email });
            if (!user) {
                return res.json({ success: false, message: 'Email không tồn tại!' });
            }

            const otp = generateOTP();
            const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
            await User.findByIdAndUpdate(user._id, { otp_code: otp, otp_expires: otpExpires });
            await sendEmail(email, 'Mã OTP mới - BusDN', `<p>Mã OTP mới của bạn: <strong>${otp}</strong></p>`);
            return res.json({ success: true, message: 'Mã OTP mới đã được gửi!' });
        } catch (err) {
            console.error(err);
            return res.json({ success: false, message: 'Lỗi hệ thống' });
        }
    });

    // --- EMAIL VERIFICATION (LEGACY ROUTE) ---
    router.get('/verify/:userId', async (req, res) => {
        try {
            const user = await User.findById(req.params.userId);
            if (!user) return res.send('<h1>❌ Link không hợp lệ!</h1>');
            if (user.isVerified) return res.send('<h1>✅ Đã xác thực rồi! <a href="/login">Đăng nhập</a></h1>');

            await User.findByIdAndUpdate(req.params.userId, { isVerified: true });
            return res.send(`<h1>✅ Xác thực thành công!</h1><p><a href="/login">Đăng nhập ngay</a></p>`);
        } catch (err) {
            return res.send('<h1>❌ Lỗi hệ thống!</h1>');
        }
    });

    // --- FORGOT PASSWORD ---
    router.get('/forgot-password', (req, res) => {
        res.render('forgot-password', { 
            error: req.query.error || null,
            success: req.query.success || null
        });
    });

   router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.render('forgot-password', {
                error: 'Vui lòng nhập email!',
                success: null
            });
        }

        const user = await User.findOne({ email });

        // Logic bảo mật: Luôn redirect sang trang OTP dù email đúng hay sai
        // để kẻ xấu không dùng chức năng này để dò tìm danh sách email người dùng.
        if (user) {
            // 1. Tạo OTP
            const otp = generateOTP();
            const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 phút

            // 2. Cập nhật User (Xóa luôn mật khẩu tạm cũ nếu có để tránh xung đột)
            await User.findByIdAndUpdate(user._id, {
                otp_code: otp,
                otp_expires: otpExpires,
                resetToken: null // Xóa token cũ nếu có
            });

            // 3. Gửi Email (Bất đồng bộ - không dùng await nếu muốn tốc độ nhanh hơn, 
            // nhưng nên dùng để đảm bảo mail đã gửi trước khi chuyển trang)
            await sendEmail(email, 'Khôi phục mật khẩu - Mã OTP', 
                `<div style="font-family: Arial; text-align: center;">
                    <h2>Mã xác thực của bạn là:</h2>
                    <h1 style="color: #003366; letter-spacing: 5px;">${otp}</h1>
                    <p>Mã có hiệu lực trong 10 phút.</p>
                </div>`
            );
        }

        // CHỐT: Chuyển hướng ngay lập tức (Xử lý lỗi ERR_HTTP_HEADERS_SENT)
        // Dùng redirect thay vì render để trình duyệt "sang trang mới" hẳn hoi.
        const successMsg = encodeURIComponent('Nếu email tồn tại, mã OTP đã được gửi thành công!');
        return res.redirect(`/verify-otp?email=${encodeURIComponent(email)}&type=forgot-password&success=${successMsg}`);

    } catch (err) {
        console.error("Lỗi Forgot Password:", err);
        return res.render('forgot-password', {
            error: 'Đã có lỗi xảy ra, vui lòng thử lại sau.',
            success: null
        });
    }
});

    // --- RESET PASSWORD ---
    router.get('/reset-password', async (req, res) => {
        try {
            const { token, email } = req.query;
            
            if (!token || !email) {
                return res.redirect('/login?error=' + encodeURIComponent('Link không hợp lệ!'));
            }

            const user = await User.findOne({ email });
            
            if (!user || user.resetToken !== token) {
                return res.redirect('/login?error=' + encodeURIComponent('Link đã hết hạn hoặc không hợp lệ!'));
            }

            return res.render('reset-password', {
                token,
                email,
                error: null,
                success: null
            });
        } catch (err) {
            console.error(err);
            return res.redirect('/login?error=' + encodeURIComponent('Lỗi hệ thống'));
        }
    });

    router.post('/reset-password', async (req, res) => {
    try {
        const { email, token, newPassword, confirmPassword } = req.body;

        if (!newPassword || !confirmPassword) {
            return res.render('reset-password', {
                token, email,
                error: 'Vui lòng điền đầy đủ thông tin!',
                success: null
            });
        }

        if (!checkPassword(newPassword)) {
            return res.render('reset-password', {
                token, email,
                error: PASS_ERR_MSG,
                success: null
            });
        }

        if (newPassword !== confirmPassword) {
            return res.render('reset-password', {
                token, email,
                error: 'Mật khẩu không khớp!',
                success: null
            });
        }

        const user = await User.findOne({ email });

        if (!user || user.resetToken !== token) {
            return res.redirect('/login?error=' + encodeURIComponent('Token không hợp lệ hoặc đã hết hạn!'));
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await User.findByIdAndUpdate(user._id, {
            password: hashedPassword,
            resetToken: null,
            isVerified: true,
            otp_code: null,
            otp_expires: null,
            isFirstLogin: false // Đồng bộ logic: Đã đổi pass thì không cần bắt đổi lại
        });

        return res.redirect('/login?success=' + encodeURIComponent('Đặt lại mật khẩu thành công! Vui lòng đăng nhập với mật khẩu mới.'));

    } catch (err) {
        console.error(err);
        return res.render('reset-password', {
            token: req.body.token,
            email: req.body.email,
            error: 'Lỗi hệ thống',
            success: null
        });
    }
});

    // --- LOGOUT ---
    router.get('/logout', (req, res) => {
        req.session.destroy();
        return res.redirect('/login');
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
            return res.render('profile', { user: user, error, success });
        } catch (err) {
            console.error(err);
            return res.redirect('/home');
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
    router.get('/change-password', async (req, res) => {
        if (!req.session.userId) return res.redirect('/login');
        return res.render('change-password', {
            error: req.query.error || null,
            success: req.query.success || null,
            forceChange: req.query.firstLogin === '1'
        });
    });

    router.post('/change-password', async (req, res) => {
        if (!req.session.userId) return res.redirect('/login');
        const { oldPassword, newPassword, confirmPassword } = req.body;
        const user = await User.findById(req.session.userId);
        const isForceChange = !!(user && user.isFirstLogin);
        const errorBase = isForceChange ? '/change-password?firstLogin=1' : '/profile';
        const errorJoin = isForceChange ? '&' : '?';

        if (!checkPassword(newPassword)) {
            return res.redirect(errorBase + errorJoin + 'error=' + encodeURIComponent(PASS_ERR_MSG));
        }

        if (newPassword !== confirmPassword) {
            return res.redirect(errorBase + errorJoin + 'error=' + encodeURIComponent('Mat khau moi khong khop!'));
        }

        if (!(await bcrypt.compare(oldPassword, user.password))) {
            return res.redirect(errorBase + errorJoin + 'error=' + encodeURIComponent('Mat khau cu khong dung!'));
        }

        const hashedPassword = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
        await User.findByIdAndUpdate(req.session.userId, {
            password: hashedPassword,
            isFirstLogin: false
        });

        if (isForceChange) {
            if (req.session.role === 'ADMIN') return res.redirect('/admin/dashboard?success=' + encodeURIComponent('Doi mat khau thanh cong!'));
            if (req.session.role === 'PASSENGER') return res.redirect('/home?success=' + encodeURIComponent('Doi mat khau thanh cong!'));
        }

        return res.redirect('/profile?success=' + encodeURIComponent('Doi mat khau thanh cong!'));
    });

    // --- ROUTE LOOKUP PAGE ---
    router.get('/route-lookup', (req, res) => {
        return res.render('route-lookup');
    });

    // --- PUBLIC API ROUTES (NO AUTHENTICATION) ---
    // Get all routes with optional search filter
    router.get('/api/public/routes', getAllRoutes);

    // Get detailed route information with stops
    router.get('/api/public/routes/:routeId', getRouteDetail);

    // Get route GeoJSON data for map display
    router.get('/api/public/routes/:routeId/geojson', getRouteGeoJSON);

    // Get live vehicles running on a route
    router.get('/api/public/routes/:routeId/live', getRouteLiveVehicles);

    return router;

};
