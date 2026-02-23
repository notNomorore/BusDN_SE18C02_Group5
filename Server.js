const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const app = express();


// --- 1. KẾT NỐI MONGODB ---
mongoose.connect('mongodb+srv://DE181046:nhatminh@busdn.2y1qib0.mongodb.net/?appName=BusDN')
    .then(() => console.log("✅ Đã kết nối MongoDB Atlas"))
    .catch(err => console.error("❌ Lỗi kết nối DB:", err));

const { User, Route, Schedule, Bus } = require('./models');

// --- HÀM KIỂM TRA MẬT KHẨU (THEO YÊU CẦU CỦA BẠN) ---
const checkPassword = (password) => {
    // 1. Độ dài >= 4
    if (password.length < 4) return false;
    // 2. Không chứa dấu cách
    if (/\s/.test(password)) return false;
    // 3. Ít nhất 1 chữ hoa
    if (!/[A-Z]/.test(password)) return false;
    // 4. Ít nhất 1 chữ số
    if (!/[0-9]/.test(password)) return false;
    // 5. Ít nhất 1 ký tự đặc biệt (!@#$%^&*...)
    if (!/[\W_]/.test(password)) return false;

    return true;
};
const PASS_ERR_MSG = "Mật khẩu phải có ít nhất 4 ký tự, 1 chữ hoa, 1 số, 1 ký tự đặc biệt và KHÔNG có khoảng trắng!";

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

// --- 6. XỬ LÝ ĐĂNG KÝ (ĐÃ THÊM VALIDATE PASS) ---
app.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;

        // --- VALIDATE PASSWORD ---
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

// --- RESET PASSWORD (ĐÃ THÊM VALIDATE PASS) ---
app.post('/reset-password/:userId', async (req, res) => {
    try {
        const { password, confirmPassword } = req.body;

        // --- VALIDATE PASSWORD ---
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

// --- 8. ADMIN HELPER & ROUTES ---
const isAdmin = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.role === 'ADMIN') next();
    else return res.redirect('/profile');
};

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


const parseRoutePayload = (body) => {
    const routeNumber = (body.routeNumber || '').trim().toUpperCase();
    const name = (body.name || '').trim();
    const description = (body.description || '').trim();
    const distanceRaw = String(body.distance ?? '').trim();
    const startTime = (body.startTime || '').trim();
    const endTime = (body.endTime || '').trim();
    const status = (body.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

    return {
        routeNumber,
        name,
        description,
        distanceRaw,
        distance: distanceRaw === '' ? null : Number(distanceRaw),
        startTime,
        endTime,
        status
    };
};

const validateRoutePayload = (payload, { requireTime = false } = {}) => {
    const errors = [];

    if (!payload.routeNumber) errors.push('Vui lòng nhập mã tuyến.');
    if (!payload.name) errors.push('Vui lòng nhập tên tuyến.');

    if (payload.distanceRaw === '' || Number.isNaN(payload.distance) || payload.distance <= 0) {
        errors.push('Cự ly phải là số lớn hơn 0.');
    }

    const hasStart = !!payload.startTime;
    const hasEnd = !!payload.endTime;
    if (requireTime || hasStart || hasEnd) {
        if (!hasStart || !hasEnd) {
            errors.push('Vui lòng nhập đầy đủ giờ bắt đầu và giờ kết thúc.');
        } else if (payload.startTime >= payload.endTime) {
            errors.push('Giờ kết thúc phải lớn hơn giờ bắt đầu.');
        }
    }

    return errors;
};

const routeListRedirect = (res, type, message) => {
    const q = new URLSearchParams();
    q.set(type, message);
    return res.redirect('/admin/routes?' + q.toString());
};

// helpers for schedule logic
const parseSchedulePayload = (body) => {
    const date = body.date ? new Date(body.date) : null;
    const routeId = body.routeId ? body.routeId.trim() : '';
    const busId = body.busId ? body.busId.trim() : '';
    const driverId = body.driverId ? body.driverId.trim() : '';
    const startTime = (body.startTime || '').trim();
    const endTime = (body.endTime || '').trim();
    return { date, routeId, busId, driverId, startTime, endTime };
};

const validateSchedulePayload = (payload) => {
    const errors = [];
    if (!payload.date || isNaN(payload.date.getTime())) errors.push('Vui lòng chọn ngày.');
    if (!payload.routeId) errors.push('Vui lòng chọn tuyến.');
    if (!payload.busId) errors.push('Vui lòng chọn xe.');
    if (!payload.driverId) errors.push('Vui lòng chọn tài xế.');
    if (!payload.startTime || !payload.endTime) {
        errors.push('Vui lòng nhập giờ bắt đầu và kết thúc.');
    } else if (payload.startTime >= payload.endTime) {
        errors.push('Giờ kết thúc phải lớn hơn giờ bắt đầu.');
    }
    return errors;
};

const scheduleListRedirect = (res, date, type, message) => {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    q.set(type, message);
    return res.redirect('/admin/schedules?' + q.toString());
};

app.get('/admin/dashboard', isAdmin, (req, res) => renderAdmin(req, res, 'admin/dashboard', 'Tổng quan'));

app.get('/admin/routes', isAdmin, async (req, res) => {
    try {
        const routes = await Route.find({}).sort({ routeNumber: 1, createdAt: -1 });
        return renderAdmin(req, res, 'admin/routes', 'Quản lý Tuyến', {
            routes,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('❌ Lỗi tải danh sách tuyến:', err);
        return renderAdmin(req, res, 'admin/routes', 'Quản lý Tuyến', {
            routes: [],
            success: null,
            error: 'Không thể tải danh sách tuyến.'
        });
    }
});

app.post('/admin/routes/create', isAdmin, async (req, res) => {
    try {
        const payload = parseRoutePayload(req.body);
        const errors = validateRoutePayload(payload);
        if (errors.length) return routeListRedirect(res, 'error', errors[0]);

        const duplicated = await Route.findOne({ routeNumber: payload.routeNumber });
        if (duplicated) return routeListRedirect(res, 'error', 'Mã tuyến đã tồn tại.');

        await Route.create({
            routeNumber: payload.routeNumber,
            name: payload.name,
            description: payload.description,
            distance: payload.distance,
            status: payload.status,
            operationTime: (payload.startTime && payload.endTime)
                ? { start: payload.startTime, end: payload.endTime }
                : { start: '', end: '' }
        });

        return routeListRedirect(res, 'success', 'Tạo tuyến thành công!');
    } catch (err) {
        console.error('❌ Lỗi tạo tuyến:', err);
        return routeListRedirect(res, 'error', 'Lỗi hệ thống khi tạo tuyến.');
    }
});

app.post('/admin/routes/:id/update', isAdmin, async (req, res) => {
    try {
        const payload = parseRoutePayload(req.body);
        const errors = validateRoutePayload(payload);
        if (errors.length) return routeListRedirect(res, 'error', errors[0]);

        const route = await Route.findById(req.params.id);
        if (!route) return routeListRedirect(res, 'error', 'Tuyến không tồn tại.');

        const duplicated = await Route.findOne({ routeNumber: payload.routeNumber, _id: { $ne: route._id } });
        if (duplicated) return routeListRedirect(res, 'error', 'Mã tuyến đã tồn tại.');

        route.routeNumber = payload.routeNumber;
        route.name = payload.name;
        route.description = payload.description;
        route.distance = payload.distance;
        route.status = payload.status;
        route.operationTime = (payload.startTime && payload.endTime)
            ? { start: payload.startTime, end: payload.endTime }
            : { start: '', end: '' };

        await route.save();
        return routeListRedirect(res, 'success', 'Cập nhật tuyến thành công!');
    } catch (err) {
        console.error('❌ Lỗi cập nhật tuyến:', err);
        return routeListRedirect(res, 'error', 'Lỗi hệ thống khi cập nhật tuyến.');
    }
});

app.post('/admin/routes/:id/deactivate', isAdmin, async (req, res) => {
    try {
        const route = await Route.findById(req.params.id);
        if (!route) return routeListRedirect(res, 'error', 'Tuyến không tồn tại.');
        if ((route.status || 'ACTIVE') === 'INACTIVE') {
            return routeListRedirect(res, 'error', 'Tuyến đã tạm ngưng trước đó.');
        }

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const busySchedule = await Schedule.findOne({
            routeId: route._id,
            date: { $gte: startOfToday }
        });

        if (busySchedule) {
            return routeListRedirect(res, 'error', 'Không thể tạm ngưng: tuyến đang có lịch chạy hiện tại/sắp tới.');
        }

        route.status = 'INACTIVE';
        await route.save();
        return routeListRedirect(res, 'success', 'Tạm ngưng tuyến thành công!');
    } catch (err) {
        console.error('❌ Lỗi tạm ngưng tuyến:', err);
        return routeListRedirect(res, 'error', 'Lỗi hệ thống khi tạm ngưng tuyến.');
    }
});

app.get('/admin/schedules', isAdmin, async (req, res) => {
    try {
        // determine date filter; default to today
        let selectedDate = req.query.date ? new Date(req.query.date) : new Date();
        selectedDate.setHours(0,0,0,0);
        const nextDay = new Date(selectedDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // load schedules for that day
        const schedules = await Schedule.find({
            date: { $gte: selectedDate, $lt: nextDay }
        })
        .populate('routeId')
        .populate('busId')
        .populate('driverId');

        const routes = await Route.find({ status: 'ACTIVE' }).sort({ routeNumber: 1 });
        const buses = await Bus.find({});
        const drivers = await User.find({ role: 'DRIVER' });

        return renderAdmin(req, res, 'admin/schedules', 'Điều phối Lịch', {
            schedules,
            routes,
            buses,
            drivers,
            selectedDate: selectedDate.toISOString().slice(0,10),
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('❌ Lỗi tải lịch chạy:', err);
        return renderAdmin(req, res, 'admin/schedules', 'Điều phối Lịch', {
            schedules: [],
            routes: [],
            buses: [],
            drivers: [],
            selectedDate: new Date().toISOString().slice(0,10),
            success: null,
            error: 'Không thể tải lịch.'
        });
    }
});

app.post('/admin/schedules/create', isAdmin, async (req, res) => {
    try {
        const payload = parseSchedulePayload(req.body);
        const errors = validateSchedulePayload(payload);
        if (errors.length) return scheduleListRedirect(res, req.body.date, 'error', errors[0]);

        // conflict checks: same bus or driver on same date
        const conflict = await Schedule.findOne({
            date: payload.date,
            $or: [{ busId: payload.busId }, { driverId: payload.driverId }]
        });
        if (conflict) {
            return scheduleListRedirect(res, req.body.date, 'error', 'Xe hoặc tài xế đã có lịch trong cùng ngày.');
        }

        await Schedule.create({
            driverId: payload.driverId,
            busId: payload.busId,
            routeId: payload.routeId,
            date: payload.date,
            shiftTime: { start: payload.startTime, end: payload.endTime }
        });

        return scheduleListRedirect(res, req.body.date, 'success', 'Tạo lịch thành công!');
    } catch (err) {
        console.error('❌ Lỗi tạo lịch:', err);
        return scheduleListRedirect(res, req.body.date, 'error', 'Lỗi hệ thống khi tạo lịch.');
    }
});
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

    // Lấy thông báo từ URL (nếu có)
    const error = req.query.error;
    const success = req.query.success;

    res.render('profile', { user, error, success });
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
    await User.findByIdAndUpdate(req.session.userId, {
        fullName: req.body.fullName,
        phone: req.body.phone
    });

    if (req.session.role === 'ADMIN') return res.redirect('/admin/profile');
    if (req.session.role === 'PASSENGER') return res.redirect('/home');
    return res.redirect('/profile');
});

// --- CHANGE PASSWORD (ĐÃ THÊM VALIDATE PASS) ---
app.post('/change-password', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const user = await User.findById(req.session.userId);

    // --- VALIDATE PASSWORD ---
    if (!checkPassword(newPassword)) {
        return res.redirect('/profile?error=' + encodeURIComponent(PASS_ERR_MSG));
    }

    // Kiểm tra mật khẩu mới khớp nhau không
    if (newPassword !== confirmPassword) {
        return res.redirect('/profile?error=' + encodeURIComponent('Mật khẩu mới không khớp!'));
    }

    // Kiểm tra mật khẩu cũ
    if (!(await bcrypt.compare(oldPassword, user.password))) {
        return res.redirect('/profile?error=' + encodeURIComponent('Mật khẩu cũ không đúng!'));
    }

    // Đổi mật khẩu thành công
    const hashedPassword = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
    await User.findByIdAndUpdate(req.session.userId, { password: hashedPassword });

    return res.redirect('/profile?success=' + encodeURIComponent('Đổi mật khẩu thành công!'));
});
app.post('/admin/routes/:id/activate', isAdmin, async (req, res) => {
    try {
        const route = await Route.findById(req.params.id);
        if (!route) return routeListRedirect(res, 'error', 'Tuyến không tồn tại.');

        if ((route.status || 'ACTIVE') === 'ACTIVE') {
            return routeListRedirect(res, 'error', 'Tuyến đang hoạt động.');
        }

        route.status = 'ACTIVE';
        await route.save();

        return routeListRedirect(res, 'success', 'Kích hoạt lại tuyến thành công!');
    } catch (err) {
        console.error('❌ Lỗi kích hoạt lại tuyến:', err);
        return routeListRedirect(res, 'error', 'Lỗi hệ thống khi kích hoạt lại tuyến.');
    }
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