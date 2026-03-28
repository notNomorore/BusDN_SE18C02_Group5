require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const connectDB = require('./config/connectdb');
const models = require("./models/models");
const { Route, Schedule, User } = models;
const { normalizeAvatarPath } = require('./utils/avatar');
// --- 1. IMPORT CONFIGURATIONS ---
const configViewEngine = require('./config/viewEngine');
const configPassport = require('./config/passport');
const { upload, priorityProfileUpload } = require('./config/multer');
const { setIO } = require('./config/socket');
const { enforcePriorityExpiry } = require('./middleware/priorityEnforcement');
const { applyPriorityExpiryForUser } = require('./utils/priorityUtils');
const { persistTrackingLocation, scanAndNotifyStaleGps } = require('./controllers/scheduleController');

// --- 2. SETUP EXPRESS APP ---
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const getFrontendOrigin = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const allowedFrontendOrigins = new Set([
    getFrontendOrigin(),
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'https://busdn-se18c02.web.app',
    'https://busdn-se18c02.firebaseapp.com'
]);
const isAllowedFrontendOrigin = (origin) => {
    if (!origin) return false;
    if (allowedFrontendOrigins.has(origin)) return true;

    try {
        const parsed = new URL(origin);
        return parsed.protocol === 'https:'
            && (parsed.hostname.endsWith('.web.app') || parsed.hostname.endsWith('.firebaseapp.com'));
    } catch {
        return false;
    }
};
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || isAllowedFrontendOrigin(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    optionsSuccessStatus: 204
};
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (!origin || isAllowedFrontendOrigin(origin)) {
                callback(null, true);
                return;
            }

            callback(new Error(`Origin ${origin} is not allowed by CORS.`));
        },
        credentials: true
    }
});
setIO(io);

const GOOGLE_AUTH_SOURCE = 'busdn-google-auth';
const getRoleRedirectPath = (role) => {
    if (role === 'ADMIN' || role === 'STAFF') return '/admin/dashboard';
    if (role === 'DRIVER') return '/driver/schedule';
    if (role === 'CONDUCTOR') return '/conductor/schedule';
    return '/';
};

const buildGoogleAuthPopupHtml = (payload) => {
    const serializedPayload = JSON.stringify(payload).replace(/</g, '\\u003c');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BusDN Google Authentication</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      display: grid;
      place-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f6fffb;
      color: #0f172a;
    }
    .card {
      max-width: 360px;
      padding: 24px;
      text-align: center;
      border: 1px solid #d1fae5;
      border-radius: 16px;
      background: #fff;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    .title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    .text { font-size: 14px; color: #475569; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">BusDN</div>
    <div class="text">Đang hoàn tất đăng nhập Google. Bạn có thể đóng cửa sổ này nếu không tự động quay lại.</div>
  </div>
  <script>
    (function () {
      var payload = ${serializedPayload};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, '*');
        }
      } catch (error) {
        console.error(error);
      }
      setTimeout(function () {
        window.close();
      }, 100);
    })();
  </script>
</body>
</html>`;
};

const sendGoogleAuthPopup = (res, payload) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return res.status(200).send(buildGoogleAuthPopupHtml(payload));
};

// --- 3. DATABASE CONNECTION ---
connectDB(); 

// --- 4. MIDDLEWARE (Tối ưu từ cả hai nhánh) ---
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || "my_secret_key",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        secure: process.env.NODE_ENV === 'production'
    },
}));

io.on('connection', (socket) => {
    socket.on('admin:join', () => {
        socket.join('admins');
    });

    socket.on('tracking:subscribe-route', ({ routeId }) => {
        if (!routeId || typeof routeId !== 'string') return;
        socket.join(`route:${routeId}`);
    });

    socket.on('tracking:unsubscribe-route', ({ routeId }) => {
        if (!routeId || typeof routeId !== 'string') return;
        socket.leave(`route:${routeId}`);
    });

    socket.on('auth:join', ({ token }) => {
        try {
            if (!token || typeof token !== 'string') return;
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
            if (!decoded?.userId || !decoded?.role) return;

            socket.data.userId = String(decoded.userId);
            socket.data.role = decoded.role;
            socket.join(`user:${decoded.userId}`);
            socket.join(`role:${decoded.role}`);
        } catch (err) {
            // ignore invalid token
        }
    });

    socket.on('tracking:update-location', async (payload = {}, callback) => {
        try {
            if (!socket.data?.userId) {
                throw new Error('Unauthorized socket');
            }

            const schedule = await persistTrackingLocation({
                ...payload,
                userId: socket.data.userId
            });

            if (typeof callback === 'function') {
                callback({
                    ok: true,
                    scheduleId: String(schedule._id),
                    updatedAt: schedule.currentLocation?.updatedAt || new Date().toISOString()
                });
            }
        } catch (error) {
            if (typeof callback === 'function') {
                callback({
                    ok: false,
                    message: error.message || 'Tracking update failed'
                });
            }
        }
    });
});

setInterval(() => {
    scanAndNotifyStaleGps().catch((error) => {
        console.error('scanAndNotifyStaleGps error:', error);
    });
}, 30000);

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

const uploadsRoot = path.join(__dirname, 'public', 'uploads');
const priorityUploadsRoot = path.join(uploadsRoot, 'priority');
const resolvedUploadsRoot = path.resolve(uploadsRoot);

[uploadsRoot, priorityUploadsRoot].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const resolveFallbackPriorityUpload = (requestedPath) => {
    const normalized = String(requestedPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized.startsWith('priority/')) {
        return null;
    }

    const fileName = path.posix.basename(normalized);
    const match = fileName.match(/^priority-([^/]+)-(\d+)-[^.]+\.[^.]+$/i) || fileName.match(/^priority-([^/]+)-(\d+)\.[^.]+$/i);
    if (!match) {
        return null;
    }

    const userId = match[1];
    const requestedExt = path.extname(fileName).toLowerCase();
    const prefix = `priority-${userId}-`;

    let candidates = [];
    try {
        candidates = fs.readdirSync(priorityUploadsRoot)
            .filter((name) => name.startsWith(prefix))
            .map((name) => {
                const fullPath = path.join(priorityUploadsRoot, name);
                const stat = fs.statSync(fullPath);
                return {
                    name,
                    fullPath,
                    ext: path.extname(name).toLowerCase(),
                    mtime: stat.mtimeMs
                };
            });
    } catch (error) {
        return null;
    }

    if (!candidates.length) {
        return null;
    }

    const sameExt = candidates.filter((item) => item.ext === requestedExt);
    const pool = sameExt.length ? sameExt : candidates;

    return pool
        .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
        .at(0)?.fullPath || null;
};

app.use('/uploads', (req, res, next) => {
    const requestedPath = decodeURIComponent(req.path || '');
    const normalizedPath = requestedPath.replace(/^\/+/, '');
    const candidatePath = path.resolve(uploadsRoot, normalizedPath);

    if ((candidatePath === resolvedUploadsRoot || candidatePath.startsWith(`${resolvedUploadsRoot}${path.sep}`)) && fs.existsSync(candidatePath)) {
        return res.sendFile(candidatePath);
    }

    const fallbackPath = resolveFallbackPriorityUpload(normalizedPath);
    if (fallbackPath) {
        console.warn(`Priority upload fallback used for ${normalizedPath} -> ${path.basename(fallbackPath)}`);
        return res.sendFile(fallbackPath);
    }

    return next();
});

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
app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', { session: false }, async (err, user, info) => {
        try {
            if (err || !user) {
                return sendGoogleAuthPopup(res, {
                    source: GOOGLE_AUTH_SOURCE,
                    status: 'error',
                    error: info?.message || err?.message || 'Google authentication failed.'
                });
            }

            if (user.isLocked || user.status === 'LOCKED') {
                return sendGoogleAuthPopup(res, {
                    source: GOOGLE_AUTH_SOURCE,
                    status: 'error',
                    error: 'Tài khoản của bạn đã bị khóa.'
                });
            }

            if (!user.isVerified) {
                return sendGoogleAuthPopup(res, {
                    source: GOOGLE_AUTH_SOURCE,
                    status: 'error',
                    error: 'Tài khoản chưa được xác thực.'
                });
            }

            await applyPriorityExpiryForUser(user._id);

            req.session.userId = user._id;
            req.session.role = user.role;

            const token = jwt.sign(
                { userId: user._id, role: user.role },
                process.env.JWT_SECRET || 'secret_key',
                { expiresIn: '7d' }
            );

            return sendGoogleAuthPopup(res, {
                source: GOOGLE_AUTH_SOURCE,
                status: 'success',
                token,
                user: {
                    id: String(user._id),
                    fullName: user.fullName,
                    email: user.email,
                    phone: user.phone,
                    role: user.role,
                    avatar: normalizeAvatarPath(user.avatar),
                    isFirstLogin: !!user.isFirstLogin,
                    status: user.status || null
                },
                redirectTo: getRoleRedirectPath(user.role)
            });
        } catch (error) {
            console.error('Google auth callback error:', error);
            return sendGoogleAuthPopup(res, {
                source: GOOGLE_AUTH_SOURCE,
                status: 'error',
                error: 'Google authentication failed.'
            });
        }
    })(req, res, next);
});
// --- 7. ROOT ROUTE ---
app.get('/', (req, res) => {
    return res.render('home', { user: res.locals.user || null });
});
// --- 8. START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server chạy tại: http://localhost:${PORT}`));
