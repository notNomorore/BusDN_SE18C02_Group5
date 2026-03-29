const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models/models');
const { applyPriorityExpiryForUser } = require('../utils/priorityUtils');
const { normalizeAvatarPath } = require('../utils/avatar');
const {
    buildEmailRegex,
    buildLoginLookup,
    buildPhoneVariants,
    normalizeEmail,
    normalizePhone,
    normalizeText
} = require('../utils/authIdentity');
const { sendEmail } = require('../config/helpers');
require('dotenv').config();

const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

exports.register = async (req, res) => {
    try {
        const fullName = normalizeText(req.body.fullName);
        const email = normalizeEmail(req.body.email);
        const phone = normalizePhone(req.body.phone);
        const { password } = req.body;

        if (!fullName || !password || !email) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        let user = email ? await User.findOne({ email: buildEmailRegex(email) }) : null;
        if (!user && phone) {
            user = await User.findOne({ phone: { $in: buildPhoneVariants(phone) } });
        }
        if (user) {
            return res.status(400).json({ message: 'Email already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const otp = generateOTP();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

        user = new User({
            fullName,
            email: email || undefined,
            phone: phone || undefined,
            password: hashedPassword,
            otp_code: otp,
            otp_expires: otpExpires,
            isFirstLogin: false,
            isVerified: false
        });

        await user.save();

        const emailSent = await sendEmail(
            email,
            'Ma xac thuc BusDN',
            `<p>Ma OTP cua ban la: <strong>${otp}</strong>.</p><p>Ma co hieu luc trong 10 phut.</p>`
        );

        if (!emailSent) {
            await User.deleteOne({ _id: user._id });
            return res.status(502).json({
                message: 'Khong the gui email xac thuc. Vui long thu lai sau.'
            });
        }

        return res.status(201).json({ message: 'OTP Sent', userId: user._id });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Loi Server' });
    }
};
exports.verifyOTP = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const { otp } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Invalid email' });
        }
        const user = await User.findOne({ email: buildEmailRegex(email) });

        if (!user) {
            return res.status(400).json({ message: 'Người dùng không tồn tại' });
        }

        if (user.otp_code !== otp || user.otp_expires < Date.now()) {
            return res.status(400).json({ message: 'Mã OTP không hợp lệ hoặc đã hết hạn' });
        }

        user.isVerified = true;
        user.otp_code = undefined;
        user.otp_expires = undefined;
        await user.save();

        res.json({ message: 'Account Verified' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi Server' });
    }
};

exports.login = async (req, res) => {
    try {
        const lookup = buildLoginLookup(req.body.identifier || req.body.email || req.body.phone || '');
        const { password } = req.body;
        const query = [];

        if (lookup?.emailRegex) {
            query.push({ email: lookup.emailRegex });
        }

        if (lookup?.phoneVariants?.length) {
            query.push({ phone: { $in: lookup.phoneVariants } });
        }

        const user = query.length ? await User.findOne({ $or: query }) : null;

        if (!user) {
            return res.status(400).json({ message: 'Sai email hoặc mật khẩu' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Sai email hoặc mật khẩu' });
        }

        if (!user.isVerified) {
            return res.status(400).json({ message: 'Tài khoản chưa được xác thực' });
        }
        if (user.isLocked || user.status === 'LOCKED') {
            return res.status(400).json({ message: 'Tai khoan da bi khoa' });
        }

        await applyPriorityExpiryForUser(user._id);

        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET || 'secret_key',
            { expiresIn: '7d' }
        );

        return res.json({
            message: 'Login successful',
            token,
            status: user.status,
            activationRequired: user.status === 'INACTIVE'
                || user.status === 'PENDING_ACTIVATION'
                || !!user.isFirstLogin,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phone: user.phone,
                role: user.role,
                avatar: normalizeAvatarPath(user.avatar),
                status: user.status,
                isFirstLogin: !!user.isFirstLogin
            }
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Lỗi Server' });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        if (!email) {
            return res.status(400).json({ message: 'Invalid email' });
        }
        const user = await User.findOne({ email: buildEmailRegex(email) });

        if (!user) {
            return res.status(400).json({ message: 'Email not found' });
        }

        const otp = generateOTP();
        user.otp_code = otp;
        user.otp_expires = new Date(Date.now() + 10 * 60 * 1000);
        await user.save();

        const emailSent = await sendEmail(
            email,
            'Quen mat khau BusDN',
            `<p>Ma OTP khoi phuc mat khau cua ban la: <strong>${otp}</strong></p>`
        );

        if (!emailSent) {
            user.otp_code = undefined;
            user.otp_expires = undefined;
            await user.save();
            return res.status(502).json({
                message: 'Khong the gui email khoi phuc mat khau. Vui long thu lai sau.'
            });
        }

        return res.json({ message: 'OTP Sent' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Loi Server' });
    }
};
exports.resetPassword = async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const { otp, newPassword } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Invalid email' });
        }
        const user = await User.findOne({ email: buildEmailRegex(email) });

        if (!user || user.otp_code !== otp || user.otp_expires < Date.now()) {
            return res.status(400).json({ message: 'Mã OTP không hợp lệ hoặc đã hết hạn' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.otp_code = undefined;
        user.otp_expires = undefined;
        user.isFirstLogin = false;
        await user.save();

        res.json({ message: 'Password updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi Server' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const userId = req.user.userId; // Middleware will provide this

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Mật khẩu cũ không đúng' });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.isFirstLogin = false;
        await user.save();

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi Server' });
    }
};
