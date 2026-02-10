const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer'); // <--- THÊM CÁI NÀY
const app = express();

// --- 1. KẾT NỐI MONGODB ---
mongoose.connect('mongodb+srv://DE181046:nhatminh@busdn.2y1qib0.mongodb.net/?appName=BusDN')
    .then(() => console.log("✅ Đã kết nối MongoDB Atlas"))
    .catch(err => console.error("❌ Lỗi kết nối DB:", err));

const { User } = require('./models');

// --- 2. CẤU HÌNH GỬI MAIL (NODEMAILER) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'nguyennhatminhnau@gmail.com',
        pass: 'pcum hoif vant qygx'
    }
});

const sendEmail = async (to, subject, htmlContent) => {
    try {
        await transporter.sendMail({
            from: '"BusDN Admin" <nguyennhatminhnau@gmail.com>',
            to: to,
            subject: subject,
            html: htmlContent
        });
        console.log(`✅ Đã gửi mail tới ${to}`);
    } catch (error) {
        console.error('❌ Lỗi gửi mail:', error);
    }
};

// --- 3. MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: 'my_secret_key',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Cấu hình Multer upload ảnh
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, 'avatar-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- 4. PASSPORT GOOGLE STRATEGY ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET',
    callbackURL: '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
    try {
        let user = await User.findOne({ email: profile.emails[0].value });
        if (!user) {
            user = new User({
                email: profile.emails[0].value,
                fullName: profile.displayName,
                avatar: profile.photos[0].value,
                password: 'google_oauth',
                isVerified: true,
                role: 'PASSENGER'
            });
            await user.save();
        }
        return done(null, user);
    } catch (err) {
        return done(err, null);
    }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    const user = await User.findById(id);
    done(null, user);
});

// --- 5. ROUTES CƠ BẢN ---
app.get('/', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.redirect('/profile');
});

app.get('/login', (req, res) => {
    res.render('login', { error: null, success: null });
});

// Google Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    async (req, res) => {
        req.session.userId = req.user._id;
        req.session.role = req.user.role;
        res.redirect('/home');
    }
);

// --- 6. XỬ LÝ ĐĂNG KÝ (ĐÃ SỬA LỖI GỬI MAIL) ---
app.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
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

        // GỬI MAIL THẬT
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

// --- 7. XÁC THỰC & QUÊN MẬT KHẨU ---
app.get('/verify/:userId', async (req, res) => {
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

app.get('/forgot-password', (req, res) => res.render('forgot-password'));

app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.send('<h1>Đã gửi email khôi phục (Nếu tài khoản tồn tại). <a href="/login">Quay lại</a></h1>');

    const resetLink = `http://localhost:3000/reset-password/${user._id}`;
    await sendEmail(email, 'Khôi phục mật khẩu BusDN',
        `<p>Bấm vào đây để đặt lại mật khẩu: <a href="${resetLink}">${resetLink}</a></p>`
    );

    res.send('<h1>Đã gửi mail hướng dẫn! Kiểm tra hộp thư đến. <a href="/login">Quay lại</a></h1>');
});

app.get('/reset-password/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.send('<h1>❌ Link hỏng!</h1>');
        res.render('reset-password', { userId: user._id });
    } catch (err) {
        res.send('<h1>❌ Lỗi hệ thống!</h1>');
    }
});

app.post('/reset-password/:userId', async (req, res) => {
    try {
        const { password, confirmPassword } = req.body;
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

// --- 8. ADMIN HELPER & ROUTES ---
const isAdmin = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.role === 'ADMIN') next();
    else return res.redirect('/profile');
};

// Hàm render Admin helper (đã tối ưu gọn hơn)
const renderAdmin = async (req, res, view, title, data = {}) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        res.render(view, { ...data }, (err, html) => {
            if (err) return res.send(err);
            res.render('admin/layout', {
                body: html,
                title: title,
                path: view.split('/').pop(),
                user: currentUser
            });
        });
    } catch (e) { res.redirect('/login'); }
};

app.get('/admin/dashboard', isAdmin, (req, res) => renderAdmin(req, res, 'admin/dashboard', 'Tổng quan'));
app.get('/admin/routes', isAdmin, (req, res) => renderAdmin(req, res, 'admin/routes', 'Quản lý Tuyến'));
app.get('/admin/schedules', isAdmin, (req, res) => renderAdmin(req, res, 'admin/schedules', 'Điều phối Lịch'));
app.get('/admin/profile', isAdmin, async (req, res) => {
    const user = await User.findById(req.session.userId);
    renderAdmin(req, res, 'admin/profile', 'Hồ sơ Admin', { user });
});

// --- 9. XỬ LÝ ĐĂNG NHẬP & PROFILE ---
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.render('login', { error: 'Sai email hoặc mật khẩu!', success: null });
        }
        if (!user.isVerified) {
            return res.render('login', { error: 'Tài khoản chưa xác thực email!', success: null });
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

app.get('/profile', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    res.render('profile', { user });
});

app.post('/upload-avatar', upload.single('avatar'), async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.file) {
        await User.findByIdAndUpdate(req.session.userId, { avatar: '/uploads/' + req.file.filename });
    }
    if (req.session.role === 'ADMIN') return res.redirect('/admin/profile');
    return res.redirect('/profile');
});

app.post('/edit-profile', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    await User.findByIdAndUpdate(req.session.userId, { fullName: req.body.fullName });

    if (req.session.role === 'ADMIN') return res.redirect('/admin/profile');
    if (req.session.role === 'PASSENGER') return res.redirect('/home');
    return res.redirect('/profile');
});

app.get('/change-password', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    res.render('change-password', { user, error: null, success: null });
});

app.post('/change-password', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const user = await User.findById(req.session.userId);

    if (newPassword !== confirmPassword) {
        return res.render('change-password', { user, error: 'Mật khẩu mới không khớp!', success: null });
    }
    if (!(await bcrypt.compare(oldPassword, user.password))) {
        return res.render('change-password', { user, error: 'Mật khẩu cũ không đúng!', success: null });
    }

    const hashedPassword = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
    await User.findByIdAndUpdate(req.session.userId, { password: hashedPassword });
    res.render('change-password', { user, error: null, success: 'Đổi mật khẩu thành công!' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/home', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    res.render('home', { user });
});

// --- 10. API MOBILE & KHỞI ĐỘNG ---
const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

app.listen(3000, () => console.log('🚀 Server chạy tại: http://localhost:3000'));