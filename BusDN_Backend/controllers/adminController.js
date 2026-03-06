const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { User } = require('../models/models');
const { sendEmail } = require('../config/helpers');
const { renderAdmin } = require('../middleware/renderAdmin');

const STAFF_ROLES = ['DRIVER', 'CONDUCTOR'];

const normalizeText = (value) => (value || '').toString().trim();
const normalizeEmail = (value) => normalizeText(value).toLowerCase();
const normalizePhone = (value) => normalizeText(value);
const normalizeRole = (value) => normalizeText(value).toUpperCase();

const generateSecurePassword = (length = 10) => {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const specials = '@$!%*?&';
    const all = upper + lower + digits + specials;
    const randomChar = (set) => set[Math.floor(Math.random() * set.length)];

    const targetLength = Math.max(8, Math.min(10, length));
    const seed = [
        randomChar(upper),
        randomChar(lower),
        randomChar(digits),
        randomChar(specials)
    ];

    while (seed.length < targetLength) {
        seed.push(randomChar(all));
    }

    for (let i = seed.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [seed[i], seed[j]] = [seed[j], seed[i]];
    }

    return seed.join('');
};

const buildLoginUrl = (req) => `${req.protocol}://${req.get('host')}/login`;

const buildWelcomeEmailHtml = ({ fullName, username, password, role, loginUrl }) => {
    const roleText = role === 'DRIVER' ? 'Tai xe' : 'Phu xe';
    return `
        <html>
            <body style="font-family: Arial, sans-serif; background-color: #f6f8fb; padding: 20px;">
                <div style="max-width: 620px; margin: 0 auto; background-color: #fff; border-radius: 10px; padding: 24px;">
                    <h2 style="margin-top: 0; color: #173c7a;">Tai khoan BusDN da duoc tao</h2>
                    <p>Xin chao <strong>${fullName}</strong>,</p>
                    <p>Admin da tao tai khoan nhan vien cho ban.</p>
                    <div style="background:#f3f6fc; border-left:4px solid #1f5fd2; padding:12px 14px; margin:16px 0;">
                        <p style="margin:6px 0;"><strong>Vai tro:</strong> ${roleText}</p>
                        <p style="margin:6px 0;"><strong>Tai khoan dang nhap:</strong> ${username}</p>
                        <p style="margin:6px 0;"><strong>Mat khau tam thoi:</strong> ${password}</p>
                        <p style="margin:6px 0;"><strong>Dang nhap:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
                    </div>
                    <p>Lan dang nhap dau tien, ban se bi bat buoc doi mat khau.</p>
                </div>
            </body>
        </html>
    `;
};

const createStaffRecord = async ({ fullName, email, phone, role, req }) => {
    const password = generateSecurePassword(10);
    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));

    const user = new User({
        fullName,
        email: email || undefined,
        phone: phone || undefined,
        role,
        password: hashedPassword,
        isVerified: true,
        isLocked: false,
        status: 'ACTIVE',
        isFirstLogin: true
    });

    await user.save();

    const username = email || phone;
    const accountPayload = {
        fullName,
        email: email || '',
        phone: phone || '',
        role,
        username,
        password
    };

    if (email) {
        const loginUrl = buildLoginUrl(req);
        await sendEmail(
            email,
            'Tai khoan BusDN da duoc tao',
            buildWelcomeEmailHtml({ fullName, username, password, role, loginUrl })
        );
    }

    return accountPayload;
};

const getImportRows = (fileBuffer) => {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
};

const parseImportRow = (rawRow) => {
    const fullName = normalizeText(rawRow.fullName);
    const email = normalizeEmail(rawRow.email);
    const phone = normalizePhone(rawRow.phone);
    const role = normalizeRole(rawRow.role);
    return { fullName, email, phone, role };
};

// --- 0. GET STAFF LIST (VIEW)
exports.getStaffList = async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;
        const filter = { role: { $in: STAFF_ROLES } };

        if (search) {
            filter.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }

        if (role && role !== 'ALL' && STAFF_ROLES.includes(role)) {
            filter.role = role;
        }

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 10;
        const skip = (pageNum - 1) * limitNum;
        const total = await User.countDocuments(filter);
        const users = await User.find(filter)
            .select('-password -otp_code -otp_expires')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        const onboardingInfo = req.session.staffOnboardingInfo || null;
        req.session.staffOnboardingInfo = null;

        const viewName = req.path === '/users' ? 'admin/users' : 'admin/staff-list';
        await renderAdmin(req, res, viewName, 'Quan ly Nhan vien', {
            users,
            path: 'staff-list',
            search: search || '',
            role: role || 'ALL',
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
            onboardingInfo
        });
    } catch (error) {
        console.error('Error getting staff list:', error);
        res.status(500).send(`<h1>Loi khi tai danh sach nhan vien</h1><p>${error.message}</p>`);
    }
};

exports.getCreateStaff = async (req, res) => {
    try {
        await renderAdmin(req, res, 'admin/staff-create', 'Tao tai khoan nhan vien', {
            path: 'staff-list',
            error: null,
            success: null
        });
    } catch (error) {
        console.error('Error rendering create staff page:', error);
        res.status(500).send('Loi he thong');
    }
};

// --- 1. CREATE STAFF ACCOUNT (Manual)
exports.createStaff = async (req, res) => {
    try {
        const fullName = normalizeText(req.body.fullName);
        const email = normalizeEmail(req.body.email);
        const phone = normalizePhone(req.body.phone);
        const role = normalizeRole(req.body.role);

        if (!fullName || !role || (!email && !phone)) {
            return await renderAdmin(req, res, 'admin/staff-create', 'Tao Tai khoan Nhan vien', {
                error: 'Can fullName, role va it nhat email hoac phone.',
                success: null,
                path: 'staff-list'
            });
        }

        if (!STAFF_ROLES.includes(role)) {
            return await renderAdmin(req, res, 'admin/staff-create', 'Tao Tai khoan Nhan vien', {
                error: 'Role chi co the la DRIVER hoac CONDUCTOR.',
                success: null,
                path: 'staff-list'
            });
        }

        if (email) {
            const existingByEmail = await User.findOne({ email });
            if (existingByEmail) {
                return await renderAdmin(req, res, 'admin/staff-create', 'Tao Tai khoan Nhan vien', {
                    error: 'Email da ton tai trong he thong.',
                    success: null,
                    path: 'staff-list'
                });
            }
        }

        if (phone) {
            const existingByPhone = await User.findOne({ phone });
            if (existingByPhone) {
                return await renderAdmin(req, res, 'admin/staff-create', 'Tao Tai khoan Nhan vien', {
                    error: 'So dien thoai da ton tai trong he thong.',
                    success: null,
                    path: 'staff-list'
                });
            }
        }

        const accountPayload = await createStaffRecord({ fullName, email, phone, role, req });
        req.session.staffOnboardingInfo = {
            source: 'single',
            summary: 'Tao tai khoan thanh cong.',
            accounts: email ? [] : [accountPayload]
        };

        const successMessage = email
            ? 'Tai khoan duoc tao thanh cong va email thong tin dang nhap da duoc gui.'
            : 'Tai khoan duoc tao thanh cong. Hay sao chep thong tin dang nhap de gui qua Zalo/SMS.';

        return res.redirect('/admin/staff?success=' + encodeURIComponent(successMessage));
    } catch (error) {
        console.error(error);
        const msg = error.code === 11000
            ? 'Email hoac so dien thoai da duoc su dung.'
            : (error.message || 'Da xay ra loi he thong');

        await renderAdmin(req, res, 'admin/staff-create', 'Tao Tai Khoan', {
            error: msg,
            path: 'staff-list',
            success: null
        });
    }
};

// --- 1B. BULK IMPORT STAFF FROM EXCEL/CSV
exports.importStaff = async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.redirect('/admin/staff?error=' + encodeURIComponent('Vui long tai len file Excel/CSV.'));
        }

        const rows = getImportRows(req.file.buffer);
        if (!rows.length) {
            return res.redirect('/admin/staff?error=' + encodeURIComponent('File khong co du lieu hop le.'));
        }

        const existingUsers = await User.find({
            $or: [{ email: { $ne: null } }, { phone: { $ne: null } }]
        }).select('email phone');

        const existingEmails = new Set(existingUsers.map((u) => normalizeEmail(u.email)).filter(Boolean));
        const existingPhones = new Set(existingUsers.map((u) => normalizePhone(u.phone)).filter(Boolean));
        const pendingEmails = new Set();
        const pendingPhones = new Set();

        let imported = 0;
        let failed = 0;
        const failures = [];
        const phoneOnlyAccounts = [];

        for (let i = 0; i < rows.length; i += 1) {
            const rowIndex = i + 2;
            const { fullName, email, phone, role } = parseImportRow(rows[i]);

            if (!fullName || !role || (!email && !phone)) {
                failed += 1;
                failures.push(`Dong ${rowIndex}: thieu fullName/role/email-phone.`);
                continue;
            }

            if (!STAFF_ROLES.includes(role)) {
                failed += 1;
                failures.push(`Dong ${rowIndex}: role khong hop le (${role}).`);
                continue;
            }

            if (email && (existingEmails.has(email) || pendingEmails.has(email))) {
                failed += 1;
                failures.push(`Dong ${rowIndex}: email bi trung (${email}).`);
                continue;
            }

            if (phone && (existingPhones.has(phone) || pendingPhones.has(phone))) {
                failed += 1;
                failures.push(`Dong ${rowIndex}: phone bi trung (${phone}).`);
                continue;
            }

            try {
                const accountPayload = await createStaffRecord({ fullName, email, phone, role, req });
                imported += 1;

                if (email) pendingEmails.add(email);
                if (phone) pendingPhones.add(phone);

                if (!email) {
                    phoneOnlyAccounts.push(accountPayload);
                }
            } catch (error) {
                failed += 1;
                failures.push(`Dong ${rowIndex}: ${error.message || 'tao tai khoan that bai'}`);
            }
        }

        req.session.staffOnboardingInfo = {
            source: 'bulk',
            summary: `Imported ${imported}, Failed ${failed}.`,
            accounts: phoneOnlyAccounts
        };

        const resultText = `Imported ${imported}, Failed ${failed}`;
        const noteText = failures.length
            ? ` | Chi tiet loi: ${failures.slice(0, 5).join(' ; ')}${failures.length > 5 ? ' ...' : ''}`
            : '';

        return res.redirect('/admin/staff?success=' + encodeURIComponent(resultText + noteText));
    } catch (error) {
        console.error('Error importing staff:', error);
        return res.redirect('/admin/staff?error=' + encodeURIComponent('Import that bai: ' + (error.message || 'Loi he thong')));
    }
};

// --- 2. GET ALL USERS WITH SEARCH & FILTER ---
exports.getAllUsers = async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;
        const filter = {};

        if (search) {
            filter.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }

        if (role && ['ADMIN', 'DRIVER', 'CONDUCTOR', 'PASSENGER'].includes(role)) {
            filter.role = role;
        }

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 10;
        const skip = (pageNum - 1) * limitNum;
        const total = await User.countDocuments(filter);
        const users = await User.find(filter)
            .select('-password -otp_code -otp_expires')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        res.status(200).json({
            success: true,
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
            users
        });
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).json({ error: 'Loi he thong khi lay danh sach nguoi dung' });
    }
};

// --- 3. TOGGLE LOCK/UNLOCK ACCOUNT ---
exports.toggleLock = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId);

        if (!user) return res.status(404).send('Nguoi dung khong ton tai');
        if (user.role === 'ADMIN') return res.status(403).send('Khong the khoa Admin');

        user.status = user.status === 'LOCKED' || user.isLocked ? 'ACTIVE' : 'LOCKED';
        user.isLocked = user.status === 'LOCKED';
        await user.save();

        const statusText = user.status === 'LOCKED' ? 'DA KHOA' : 'DA MO KHOA';
        if (user.email) {
            await sendEmail(
                user.email,
                'Thong bao trang thai tai khoan',
                `<p>Tai khoan cua ban da ${statusText}.</p>`
            );
        }

        return res.redirect('/admin/staff?success=' + encodeURIComponent(`Da ${statusText} tai khoan ${user.email || user.phone}`));
    } catch (error) {
        console.error(error);
        return res.status(500).send('Loi server');
    }
};

exports.getPriorityProfiles = async (req, res) => {
    try {
        const profiles = await User.find({
            'priorityProfile.status': { $in: ['PENDING', 'APPROVED', 'REJECTED'] }
        }).sort({ updatedAt: -1 });

        await renderAdmin(req, res, 'admin/priority-profiles', 'Duyet ho so uu tien', {
            profiles,
            path: 'priority-profiles'
        });
    } catch (error) {
        console.error('Loi lay ho so uu tien:', error);
        res.status(500).send('Loi may chu noi bo');
    }
};

exports.approveProfile = async (req, res) => {
    try {
        const { userId } = req.params;
        await User.findByIdAndUpdate(userId, { 'priorityProfile.status': 'APPROVED' });

        const user = await User.findById(userId);
        if (user && user.email) {
            await sendEmail(
                user.email,
                'Ho so uu tien da duoc duyet',
                '<p>Chuc mung! Ho so uu tien BusDN cua ban da duoc chap nhan.</p>'
            );
        }

        res.redirect('/admin/priority-profiles?success=Da duyet ho so');
    } catch (error) {
        res.status(500).send('Loi duyet ho so');
    }
};

exports.rejectProfile = async (req, res) => {
    try {
        const { userId } = req.params;
        await User.findByIdAndUpdate(userId, { 'priorityProfile.status': 'REJECTED' });

        const user = await User.findById(userId);
        if (user && user.email) {
            await sendEmail(
                user.email,
                'Ho so uu tien bi tu choi',
                '<p>Rat tiec, ho so uu tien cua ban khong hop le. Vui long kiem tra lai.</p>'
            );
        }

        res.redirect('/admin/priority-profiles?warning=Da tu choi ho so');
    } catch (error) {
        res.status(500).send('Loi tu choi ho so');
    }
};
