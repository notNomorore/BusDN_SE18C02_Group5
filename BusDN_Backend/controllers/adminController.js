const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { User } = require('../models/models');
const { sendEmail } = require('../config/helpers');
const { renderAdmin } = require('../middleware/renderAdmin');
const { buildFrontendLoginUrl } = require('../utils/authIdentity');

const STAFF_ROLES = ['DRIVER', 'CONDUCTOR'];

const normalizeText = (value) => (value || '').toString().trim();
const normalizeEmail = (value) => normalizeText(value).toLowerCase();
const normalizePhone = (value) => normalizeText(value);
const normalizePhoneKey = (value) => normalizeText(value).replace(/[^\d+]/g, '');
const normalizeRole = (value) => normalizeText(value).toUpperCase();
const FIELD_LABELS = {
    fullName: 'Họ tên',
    email: 'Email',
    phone: 'SĐT',
    role: 'Vai trò'
};

const VALID_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_PHONE_REGEX = /^(?:\+?84|0)\d{8,9}$/;

const pickImportValue = (rawRow, keys) => {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(rawRow || {}, key)) {
            const value = rawRow[key];
            if (value !== undefined && value !== null && `${value}`.trim() !== '') {
                return value;
            }
        }
    }
    return '';
};

const buildImportInputSnapshot = (rawRow = {}) => ({
    fullName: normalizeText(pickImportValue(rawRow, ['fullName', 'fullname', 'name', 'hoTen', 'hoten', 'Họ tên', 'Họ và tên'])),
    email: normalizeText(pickImportValue(rawRow, ['email', 'gmail', 'Email', 'Gmail'])),
    phone: normalizeText(pickImportValue(rawRow, ['phone', 'phoneNumber', 'sdt', 'SDT', 'SĐT', 'soDienThoai', 'Số điện thoại'])),
    role: normalizeText(pickImportValue(rawRow, ['role', 'vaiTro', 'vai trò', 'Vai trò']))
});

const isValidEmail = (value) => VALID_EMAIL_REGEX.test(normalizeEmail(value));
const isValidPhone = (value) => VALID_PHONE_REGEX.test(normalizePhoneKey(value));

const buildAccountSnapshot = (user) => {
    if (!user) return null;

    const statusText = user.status === 'LOCKED' || user.isLocked ? 'Đã khóa' : 'Hoạt động';
    return {
        id: user._id ? String(user._id) : null,
        fullName: normalizeText(user.fullName),
        email: normalizeEmail(user.email),
        phone: normalizePhoneKey(user.phone),
        role: user.role || '',
        status: user.status || '',
        isLocked: Boolean(user.isLocked),
        summary: `${normalizeText(user.fullName) || 'Không rõ'} | ${user.role || 'N/A'} | email: ${normalizeEmail(user.email) || '(trống)'} | SĐT: ${normalizePhoneKey(user.phone) || '(trống)'} | trạng thái: ${statusText}`,
        createdAt: user.createdAt || null
    };
};

const buildImportIssue = ({
    field = null,
    code = 'VALIDATION_ERROR',
    label = null,
    message = '',
    value = '',
    account = null,
    accounts = [],
    referenceRow = null,
    details = ''
}) => ({
    field,
    code,
    label: label || (field ? FIELD_LABELS[field] || field : 'Dữ liệu'),
    message,
    reason: message,
    value: value == null ? '' : String(value),
    account,
    accounts,
    referenceRow,
    details
});

const buildImportFailure = ({
    row,
    code = 'VALIDATION_ERROR',
    title = 'Dữ liệu không hợp lệ',
    message = 'Vui lòng kiểm tra lại các trường được đánh dấu bên dưới.',
    input,
    issues = []
}) => ({
    row,
    code,
    title,
    message,
    reason: message,
    input,
    issues
});

const buildImportFailureFromError = ({ row, input, error }) => buildImportFailure({
    row,
    code: 'SYSTEM_ERROR',
    title: 'Lỗi hệ thống',
    message: error?.message || 'Không thể tạo tài khoản.',
    input,
    issues: [buildImportIssue({
        code: 'SYSTEM_ERROR',
        label: 'Hệ thống',
        message: error?.message || 'Không thể tạo tài khoản.'
    })]
});

const formatImportFailureForFlash = (failure) => {
    if (!failure || typeof failure !== 'object') {
        return String(failure || 'Lỗi không xác định');
    }

    const prefix = Number.isFinite(Number(failure.row)) ? `Dòng ${failure.row}: ` : '';
    const message = failure.message || failure.reason || 'Lỗi không xác định';
    return `${prefix}${message}`;
};

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

const buildLoginUrl = () => buildFrontendLoginUrl();

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

const buildResetPasswordEmailHtml = ({ fullName, username, password, role, loginUrl }) => {
    const roleText = role === 'DRIVER' ? 'Tai xe' : role === 'CONDUCTOR' ? 'Phu xe' : role;
    return `
        <html>
            <body style="font-family: Arial, sans-serif; background-color: #f6f8fb; padding: 20px;">
                <div style="max-width: 620px; margin: 0 auto; background-color: #fff; border-radius: 10px; padding: 24px;">
                    <h2 style="margin-top: 0; color: #173c7a;">Mat khau BusDN da duoc dat lai</h2>
                    <p>Xin chao <strong>${fullName}</strong>,</p>
                    <p>Admin da dat lai mat khau tai khoan nhan vien cua ban.</p>
                    <div style="background:#f3f6fc; border-left:4px solid #1f5fd2; padding:12px 14px; margin:16px 0;">
                        <p style="margin:6px 0;"><strong>Vai tro:</strong> ${roleText}</p>
                        <p style="margin:6px 0;"><strong>Tai khoan dang nhap:</strong> ${username}</p>
                        <p style="margin:6px 0;"><strong>Mat khau moi tam thoi:</strong> ${password}</p>
                        <p style="margin:6px 0;"><strong>Dang nhap:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
                    </div>
                    <p>Lan dang nhap tiep theo, ban se duoc yeu cau doi mat khau.</p>
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
        email: normalizeEmail(email) || undefined,
        phone: normalizePhoneKey(phone) || undefined,
        role,
        password: hashedPassword,
        isVerified: true,
        isLocked: false,
        status: 'ACTIVE',
        isFirstLogin: true
    });

    await user.save();

    const username = normalizeEmail(email) || normalizePhoneKey(phone) || '';
    const accountPayload = {
        fullName,
        email: normalizeEmail(email) || '',
        phone: normalizePhoneKey(phone) || '',
        role,
        username,
        password
    };

    if (email) {
        const loginUrl = buildLoginUrl();
        await sendEmail(
            email,
            'Tai khoan BusDN da duoc tao',
            buildWelcomeEmailHtml({ fullName, username, password, role, loginUrl })
        );
    }

    return accountPayload;
};

exports.resetStaffPasswordApi = async (req, res) => {
    try {
        const adminUser = await User.findById(req.user?.userId).select('role');
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        const { userId } = req.params;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ ok: false, message: 'Nguoi dung khong ton tai' });
        }
        if (user.role === 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Khong the dat lai mat khau Admin' });
        }

        const password = generateSecurePassword(10);
        const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));

        user.password = hashedPassword;
        user.isFirstLogin = true;
        await user.save();

        const username = normalizeEmail(user.email) || normalizePhoneKey(user.phone) || '';
        const accountPayload = {
            fullName: user.fullName,
            email: normalizeEmail(user.email) || '',
            phone: normalizePhoneKey(user.phone) || '',
            role: user.role,
            username,
            password
        };

        if (user.email) {
            const loginUrl = buildLoginUrl();
            await sendEmail(
                user.email,
                'Mat khau BusDN da duoc dat lai',
                buildResetPasswordEmailHtml({
                    fullName: user.fullName,
                    username,
                    password,
                    role: user.role,
                    loginUrl
                })
            );

            return res.json({
                ok: true,
                emailSent: true,
                message: 'Mat khau moi da duoc gui qua email.',
                account: accountPayload
            });
        }

        return res.json({
            ok: true,
            emailSent: false,
            message: 'Mat khau moi da duoc tao.',
            account: accountPayload
        });
    } catch (error) {
        console.error('Error resetting staff password:', error);
        return res.status(500).json({ ok: false, message: 'Loi he thong khi dat lai mat khau' });
    }
};

const getImportRows = (fileBuffer) => {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    const sheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
};

const parseImportRow = (rawRow) => {
    const input = buildImportInputSnapshot(rawRow);
    const fullName = input.fullName;
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const role = normalizeRole(input.role);
    return { fullName, email, phone, role, input };
};

const processStaffImportRows = async ({ req, rows }) => {
    const existingUsers = await User.find({
        $or: [{ email: { $ne: null } }, { phone: { $ne: null } }]
    }).select('fullName email phone role status isLocked createdAt');

    const existingByEmail = new Map();
    const existingByPhone = new Map();
    for (const user of existingUsers) {
        const snapshot = buildAccountSnapshot(user);
        if (snapshot?.email) existingByEmail.set(snapshot.email, snapshot);
        if (snapshot?.phone) existingByPhone.set(snapshot.phone, snapshot);
    }

    const buildPendingSnapshot = (accountPayload) => ({
        id: accountPayload.username || null,
        fullName: normalizeText(accountPayload.fullName),
        email: normalizeEmail(accountPayload.email),
        phone: normalizePhoneKey(accountPayload.phone),
        role: accountPayload.role || '',
        status: 'ACTIVE',
        isLocked: false,
        summary: `${normalizeText(accountPayload.fullName) || 'Không rõ'} | ${accountPayload.role || 'N/A'} | email: ${normalizeEmail(accountPayload.email) || '(trống)'} | SĐT: ${normalizePhoneKey(accountPayload.phone) || '(trống)'} | trạng thái: Hoạt động`
    });

    const buildDuplicateExistingIssue = ({ field, value, account, referenceRow = null, contactLabel = null }) => buildImportIssue({
        field,
        code: `DUPLICATE_${field.toUpperCase()}`,
        label: contactLabel || FIELD_LABELS[field] || field,
        message: `${contactLabel || FIELD_LABELS[field] || field} này đã có tài khoản.`,
        value,
        account,
        referenceRow,
        details: account ? `Tài khoản hiện có: ${account.summary}` : 'Không tìm thấy thông tin tài khoản tương ứng.'
    });

    const buildDuplicatePendingIssue = ({ field, value, pendingEntry, contactLabel = null }) => buildImportIssue({
        field,
        code: `DUPLICATE_IN_FILE_${field.toUpperCase()}`,
        label: contactLabel || FIELD_LABELS[field] || field,
        message: `${contactLabel || FIELD_LABELS[field] || field} này bị trùng trong file import ở dòng ${pendingEntry.row}.`,
        value,
        account: pendingEntry.account,
        referenceRow: pendingEntry.row,
        details: `Dòng ${pendingEntry.row}: ${pendingEntry.account.summary}`
    });

    const buildContactMismatchIssue = ({ emailAccount, phoneAccount, emailValue, phoneValue }) => buildImportIssue({
        field: 'contact',
        code: 'CONTACT_MISMATCH',
        label: 'Email/SĐT',
        message: 'Email và SĐT đang thuộc 2 tài khoản khác nhau.',
        value: `${emailValue} / ${phoneValue}`,
        accounts: [emailAccount, phoneAccount],
        details: `Email khớp tài khoản: ${emailAccount.summary}. SĐT khớp tài khoản: ${phoneAccount.summary}.`
    });

    let imported = 0;
    let failed = 0;
    const failures = [];
    const phoneOnlyAccounts = [];
    const pendingByEmail = new Map();
    const pendingByPhone = new Map();

    for (let i = 0; i < rows.length; i += 1) {
        const rowIndex = i + 2;
        const input = buildImportInputSnapshot(rows[i]);
        const fullName = normalizeText(input.fullName);
        const email = normalizeEmail(input.email);
        const phone = normalizePhoneKey(input.phone);
        const role = normalizeRole(input.role);
        const issues = [];

        if (!fullName && !email && !phone && !role) {
            continue;
        }

        if (!fullName) {
            issues.push(buildImportIssue({
                field: 'fullName',
                code: 'REQUIRED_FULL_NAME',
                label: FIELD_LABELS.fullName,
                message: 'Cần nhập họ tên nhân viên.',
                value: input.fullName
            }));
        } else if (fullName.length < 2) {
            issues.push(buildImportIssue({
                field: 'fullName',
                code: 'INVALID_FULL_NAME',
                label: FIELD_LABELS.fullName,
                message: 'Họ tên phải có ít nhất 2 ký tự.',
                value: input.fullName
            }));
        }

        if (!role) {
            issues.push(buildImportIssue({
                field: 'role',
                code: 'REQUIRED_ROLE',
                label: FIELD_LABELS.role,
                message: 'Cần chọn vai trò cho nhân viên.',
                value: input.role
            }));
        } else if (!STAFF_ROLES.includes(role)) {
            issues.push(buildImportIssue({
                field: 'role',
                code: 'INVALID_ROLE',
                label: FIELD_LABELS.role,
                message: `Vai trò không hợp lệ (${input.role || 'trống'}). Chỉ chấp nhận DRIVER hoặc CONDUCTOR.`,
                value: input.role
            }));
        }

        if (!email && !phone) {
            issues.push(buildImportIssue({
                field: 'contact',
                code: 'REQUIRED_CONTACT',
                label: 'Liên hệ',
                message: 'Cần ít nhất email hoặc SĐT.',
                value: ''
            }));
        }

        if (email && !isValidEmail(email)) {
            issues.push(buildImportIssue({
                field: 'email',
                code: 'INVALID_EMAIL',
                label: FIELD_LABELS.email,
                message: 'Email không hợp lệ. Vui lòng nhập đúng định dạng email.',
                value: input.email
            }));
        }

        if (phone && !isValidPhone(phone)) {
            issues.push(buildImportIssue({
                field: 'phone',
                code: 'INVALID_PHONE',
                label: FIELD_LABELS.phone,
                message: 'Số điện thoại không hợp lệ. Vui lòng nhập 9-11 chữ số, có thể kèm mã quốc gia 84.',
                value: input.phone
            }));
        }

        const emailExisting = email && isValidEmail(email) ? existingByEmail.get(email) : null;
        const phoneExisting = phone && isValidPhone(phone) ? existingByPhone.get(phone) : null;
        const emailPending = email && isValidEmail(email) ? pendingByEmail.get(email) : null;
        const phonePending = phone && isValidPhone(phone) ? pendingByPhone.get(phone) : null;

        if (email && phone && emailExisting && phoneExisting && emailExisting.id !== phoneExisting.id) {
            issues.push(buildContactMismatchIssue({
                emailAccount: emailExisting,
                phoneAccount: phoneExisting,
                emailValue: input.email,
                phoneValue: input.phone
            }));
        } else {
            if (email && emailExisting) {
                issues.push(buildDuplicateExistingIssue({
                    field: 'email',
                    value: input.email,
                    account: emailExisting,
                    contactLabel: FIELD_LABELS.email
                }));
            } else if (email && emailPending) {
                issues.push(buildDuplicatePendingIssue({
                    field: 'email',
                    value: input.email,
                    pendingEntry: emailPending,
                    contactLabel: FIELD_LABELS.email
                }));
            }

            if (phone && phoneExisting) {
                issues.push(buildDuplicateExistingIssue({
                    field: 'phone',
                    value: input.phone,
                    account: phoneExisting,
                    contactLabel: FIELD_LABELS.phone
                }));
            } else if (phone && phonePending) {
                issues.push(buildDuplicatePendingIssue({
                    field: 'phone',
                    value: input.phone,
                    pendingEntry: phonePending,
                    contactLabel: FIELD_LABELS.phone
                }));
            }
        }

        if (issues.length > 0) {
            failed += 1;
            const title = issues.length === 1 ? issues[0].label : 'Dữ liệu không hợp lệ';
            const message = issues.length === 1
                ? issues[0].message
                : `Dòng này có ${issues.length} lỗi. Vui lòng kiểm tra các mục bên dưới.`;

            failures.push(buildImportFailure({
                row: rowIndex,
                code: issues.length === 1 ? issues[0].code : 'MULTIPLE_VALIDATION_ERRORS',
                title,
                message,
                input,
                issues
            }));
            continue;
        }

        try {
            const accountPayload = await createStaffRecord({ fullName, email, phone, role, req });
            imported += 1;

            const pendingSnapshot = buildPendingSnapshot(accountPayload);
            if (email) pendingByEmail.set(email, { row: rowIndex, account: pendingSnapshot });
            if (phone) pendingByPhone.set(phone, { row: rowIndex, account: pendingSnapshot });

            if (!email) {
                phoneOnlyAccounts.push(accountPayload);
            }
        } catch (error) {
            failed += 1;

            if (error?.code === 11000) {
                const duplicateIssues = [];
                const emailConflict = email ? existingByEmail.get(email) || pendingByEmail.get(email)?.account : null;
                const phoneConflict = phone ? existingByPhone.get(phone) || pendingByPhone.get(phone)?.account : null;

                if (email && phone && emailConflict && phoneConflict && emailConflict.id === phoneConflict.id) {
                    duplicateIssues.push(buildImportIssue({
                        field: 'contact',
                        code: 'DUPLICATE_CONTACT',
                        label: 'Email/SĐT',
                        message: 'Email và SĐT này đều đã có tài khoản.',
                        value: `${input.email} / ${input.phone}`,
                        account: emailConflict,
                        accounts: [emailConflict],
                        details: `Tài khoản hiện có: ${emailConflict.summary}`
                    }));
                } else {
                    if (email && emailConflict) {
                        duplicateIssues.push(buildDuplicateExistingIssue({
                            field: 'email',
                            value: input.email,
                            account: emailConflict,
                            contactLabel: FIELD_LABELS.email
                        }));
                    }

                    if (phone && phoneConflict) {
                        duplicateIssues.push(buildDuplicateExistingIssue({
                            field: 'phone',
                            value: input.phone,
                            account: phoneConflict,
                            contactLabel: FIELD_LABELS.phone
                        }));
                    }
                }

                if (duplicateIssues.length > 0) {
                    failures.push(buildImportFailure({
                        row: rowIndex,
                        code: duplicateIssues.length === 1 ? duplicateIssues[0].code : 'DUPLICATE_CONTACTS',
                        title: duplicateIssues.length === 1 ? duplicateIssues[0].label : 'Dữ liệu đã tồn tại',
                        message: duplicateIssues.length === 1
                            ? duplicateIssues[0].message
                            : 'Tài khoản vừa tạo bị trùng dữ liệu với tài khoản đã có.',
                        input,
                        issues: duplicateIssues
                    }));
                    continue;
                }
            }

            failures.push(buildImportFailureFromError({
                row: rowIndex,
                input,
                error
            }));
        }
    }

    return {
        imported,
        failed,
        failures,
        phoneOnlyAccounts
    };
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
        const phone = normalizePhoneKey(req.body.phone);
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

        const { imported, failed, failures, phoneOnlyAccounts } = await processStaffImportRows({ req, rows });

        req.session.staffOnboardingInfo = {
            source: 'bulk',
            summary: `Imported ${imported}, Failed ${failed}.`,
            accounts: phoneOnlyAccounts,
            failures
        };

        const resultText = `Imported ${imported}, Failed ${failed}`;
        const noteText = failures.length
            ? ` | Chi tiet loi: ${failures.slice(0, 5).map(formatImportFailureForFlash).join(' ; ')}${failures.length > 5 ? ' ...' : ''}`
            : '';

        return res.redirect('/admin/staff?success=' + encodeURIComponent(resultText + noteText));
    } catch (error) {
        console.error('Error importing staff:', error);
        return res.redirect('/admin/staff?error=' + encodeURIComponent('Import that bai: ' + (error.message || 'Loi he thong')));
    }
};

exports.importStaffApi = async (req, res) => {
    try {
        const adminUser = await User.findById(req.user?.userId).select('role');
        if (!adminUser || adminUser.role !== 'ADMIN') {
            return res.status(403).json({ ok: false, message: 'Forbidden' });
        }

        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ ok: false, message: 'Vui lòng tải lên file Excel/CSV.' });
        }

        const rows = getImportRows(req.file.buffer);
        if (!rows.length) {
            return res.status(400).json({ ok: false, message: 'File không có dữ liệu hợp lệ.' });
        }

        const { imported, failed, failures, phoneOnlyAccounts } = await processStaffImportRows({ req, rows });

        return res.json({
            ok: true,
            imported,
            failed,
            failures,
            phoneOnlyAccounts,
            message: `Imported ${imported}, Failed ${failed}`
        });
    } catch (error) {
        console.error('Error importing staff via API:', error);
        return res.status(500).json({
            ok: false,
            message: 'Import thất bại: ' + (error.message || 'Lỗi hệ thống')
        });
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
