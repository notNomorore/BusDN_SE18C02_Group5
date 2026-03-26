const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { User } = require('../models/models');
const { applyPriorityExpiryForUser } = require('../utils/priorityUtils');
const { normalizeAvatarPath } = require('../utils/avatar');
require('dotenv').config();
// Configure Nodemailer (Placeholder as requested, but functional if credentials provided)
// For real testing, use Ethereal or a real service.
const transporter = nodemailer.createTransport({
    service: 'gmail', // or your service
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const sendEmail = async (to, subject, text) => {
    try {
        await transporter.sendMail({
            from: '"BusDN Support" <nguyennhatminhnau@gmail.com>',
            to,
            subject,
            text
        });
        console.log(`Email sent to ${to}`);
    } catch (error) {
        console.error('Error sending email:', error);
    }
};

const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

exports.register = async (req, res) => {
    try {
        const { fullName, email, phone, password } = req.body;

        // Check if user exists
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ message: 'Email đã tồn tại' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Generate OTP
        const otp = generateOTP();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Create user
        user = new User({
            fullName,
            email,
            phone,
            password: hashedPassword,
            otp_code: otp,
            otp_expires: otpExpires,
            isFirstLogin: false,
            isVerified: false
        });

        await user.save();

        // Send OTP
        await sendEmail(email, 'Mã xác thực BusDN', `Mã OTP của bạn là: ${otp}. Mã có hiệu lực trong 10 phút.`);

        res.status(201).json({ message: 'OTP Sent', userId: user._id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi Server' });
    }
};

exports.verifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;
        const user = await User.findOne({ email });

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
        const identifier = (req.body.email || req.body.phone || '').trim();
        const { password } = req.body;
        const user = await User.findOne({
            $or: [
                { email: identifier.toLowerCase() },
                { phone: identifier }
            ]
        });

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
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phone: user.phone,
                role: user.role,
                avatar: normalizeAvatarPath(user.avatar),
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
        const email = (req.body.email || '').trim().toLowerCase();
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(400).json({ message: 'Email không tồn tại' });
        }

        const otp = generateOTP();
        user.otp_code = otp;
        user.otp_expires = new Date(Date.now() + 10 * 60 * 1000);
        await user.save();

        await sendEmail(email, 'Quên mật khẩu BusDN', `Mã OTP khôi phục mật khẩu của bạn là: ${otp}`);

        res.json({ message: 'OTP Sent' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Lỗi Server' });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const { otp, newPassword } = req.body;
        const user = await User.findOne({ email });

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
