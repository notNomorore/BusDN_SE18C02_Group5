const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { User } = require('../models/models');
const { checkPassword, PASS_ERR_MSG, sendEmail } = require('../config/helpers');
const { renderAdmin } = require('../middleware/renderAdmin');

// --- 0. GET STAFF LIST (VIEW) - Load users from DB and render view
exports.getStaffList = async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;

        // Build filter: Only DRIVER and CONDUCTOR
        let filter = { role: { $in: ['DRIVER', 'CONDUCTOR'] } };

        // Search by name or email (case-insensitive)
        if (search) {
            filter.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        // Filter by specific role if provided
        if (role && role !== 'ALL' && ['DRIVER', 'CONDUCTOR'].includes(role)) {
            filter.role = role;
        }

        // Calculate pagination
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 10;
        const skip = (pageNum - 1) * limitNum;

        // Get total count
        const total = await User.countDocuments(filter);

        // Get users
        const users = await User.find(filter)
            .select('-password -otp_code -otp_expires')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        // Pass data to renderAdmin
        await renderAdmin(req, res, 'admin/staff-list', 'Quản lý Nhân viên', {
            users,
            path: 'staff-list',
            search: search || '',
            role: role || 'ALL',
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
            pendingCount: 0
        });

    } catch (error) {
        console.error('Error getting staff list:', error);
        res.status(500).send(`<h1>Lỗi khi tải danh sách nhân viên</h1><p>${error.message}</p>`);
    }
};

// Thêm hàm này để hiển thị form tạo nhân viên
exports.getCreateStaff = async (req, res) => {
    try {
        await renderAdmin(req, res, 'admin/staff-create', 'Tạo tài khoản nhân viên', {
            path: 'staff-list',
            error: null, success: null
        });
    } catch (error) {
        console.error('Error rendering create staff page:', error);
        res.status(500).send("Lỗi hệ thống");
    }
};

// --- 1. CREATE STAFF ACCOUNT (Form submission)
exports.createStaff = async (req, res) => {
    try {
        const { email, password, fullName, phone, role } = req.body;

        // Validate input
        if (!email || !password || !fullName || !role) {
            // Return to form with error
            return await renderAdmin(req, res, 'admin/staff-create', 'Tạo Tài khoản Nhân viên', {
                error: 'Email, mật khẩu, tên đầy đủ và role là bắt buộc!',
                success: null,
                path: 'staff-list'
            });
        }

        // Validate role - only DRIVER and CONDUCTOR
        if (!['DRIVER', 'CONDUCTOR'].includes(role)) {
            return await renderAdmin(req, res, 'admin/staff-create', 'Tạo Tài khoản Nhân viên', {
                error: 'Role chỉ có thể là Tài xế (DRIVER) hoặc Phụ xe (CONDUCTOR)!',
                success: null
            });
        }

        // Validate password strength
        if (!checkPassword(password)) {
            return await renderAdmin(req, res, 'admin/staff-create', 'Tạo Tài khoản Nhân viên', {
                error: PASS_ERR_MSG,
                success: null
            });
        }

        // Check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return await renderAdmin(req, res, 'admin/staff-create', 'Tạo Tài khoản Nhân viên', {
                error: 'Email này đã tồn tại trong hệ thống!',
                success: null
            });
        }

        // Hash password with bcrypt
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create new staff account - automatically verified
        const newStaff = new User({
            email,
            password: hashedPassword,
            fullName,
            phone: phone || '',
            role,
            isVerified: true,  // Auto-verified for staff
            isLocked: false
        });

        await newStaff.save();
        console.log(`✅ Tài khoản mới được tạo: ${email}`);

        // Send welcome email to new staff
        const roleText = role === 'DRIVER' ? 'Tài xế' : 'Phụ xe';
        const emailContent = `
            <html>
                <body style="font-family: Arial, sans-serif; background-color: #f5f5f5; padding: 20px;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                        <h2 style="color: #333; border-bottom: 3px solid #007bff; padding-bottom: 10px;">Chào mừng ${fullName}! 👋</h2>
                        
                        <p style="color: #555; font-size: 16px;">Tài khoản BusDN của bạn đã được tạo thành công.</p>
                        
                        <div style="background-color: #f9f9f9; border-left: 4px solid #007bff; padding: 15px; margin: 20px 0;">
                            <p style="margin: 5px 0;"><strong>Chức vụ:</strong> ${roleText}</p>
                            <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
                        </div>
                        
                        <p style="color: #555; font-size: 14px;">Bạn có thể đăng nhập trên ứng dụng di động của BusDN bằng email này và mật khẩu vừa tạo.</p>
                        
                        <p style="color: #555; font-size: 14px; margin-top: 20px;">Nếu có bất kỳ thắc mắc nào, vui lòng liên hệ với Admin.</p>
                        
                        <hr style="color: #ddd; margin: 20px 0;">
                        <p style="color: #999; font-size: 12px; text-align: center;">© 2026 BusDN - Hệ thống quản lý xe buýt</p>
                    </div>
                </body>
            </html>
        `;

        await sendEmail(email, `Tài khoản BusDN được tạo thành công - ${roleText}`, emailContent);

        // Redirect to staff list with success message
        res.redirect('/admin/staff?success=Tài khoản được tạo thành công! Email xác nhận đã được gửi.');

    } catch (error) {
        console.error(error);
        let msg = 'Đã xảy ra lỗi hệ thống';

        if (error.code === 11000) {
            msg = 'Email này đã được sử dụng. Vui lòng dùng email khác!';
        } else {
            msg = error.message;
        }

        await renderAdmin(req, res, 'admin/staff-create', 'Tạo Tài Khoản', {
            error: msg,
            path: 'staff-list',
            success: null
        });
    }
};

// --- 2. GET ALL USERS WITH SEARCH & FILTER ---
exports.getAllUsers = async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;

        // Build filter object
        let filter = {};

        // Search by name or email (case-insensitive)
        if (search) {
            filter.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        // Filter by role
        if (role && ['ADMIN', 'DRIVER', 'CONDUCTOR', 'PASSENGER'].includes(role)) {
            filter.role = role;
        }

        // Calculate pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        // Get total count
        const total = await User.countDocuments(filter);

        // Get users
        const users = await User.find(filter)
            .select('-password -otp_code -otp_expires') // Exclude sensitive fields
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
        res.status(500).json({ error: 'Lỗi hệ thống khi lấy danh sách người dùng' });
    }
};

// --- 3. TOGGLE LOCK/UNLOCK ACCOUNT ---
exports.toggleLock = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId);

        if (!user) return res.status(404).send('Người dùng không tồn tại');
        if (user.role === 'ADMIN') return res.status(403).send('Không thể khóa Admin');

        // Tự đảo ngược trạng thái: nếu đang true thì thành false và ngược lại
        user.isLocked = !user.isLocked;
        await user.save();

        // Gửi mail thông báo (tùy chọn)
        const statusText = user.isLocked ? 'ĐÃ KHÓA' : 'ĐÃ MỞ KHÓA';
        await sendEmail(user.email, `Thông báo trạng thái tài khoản`, `Tài khoản của bạn đã ${statusText}.`);

        // Sau khi xử lý xong, quay lại trang danh sách nhân viên
        res.redirect('/admin/staff?success=' + encodeURIComponent(`Đã ${statusText} tài khoản ${user.email}`));
    } catch (error) {
        console.error(error);
        res.status(500).send('Lỗi server');
    }
};

// Thêm vào cuối file adminController.js
exports.getPriorityProfiles = async (req, res) => {
    try {
        // Lấy danh sách người dùng có hồ sơ ưu tiên đang chờ duyệt (PENDING) hoặc đã duyệt
        const { User } = require('../models/models');
        const profiles = await User.find({
            "priorityProfile.status": { $in: ['PENDING', 'APPROVED', 'REJECTED'] }
        }).sort({ updatedAt: -1 });

        // Dùng hàm renderAdmin đã có của bạn
        const { renderAdmin } = require('../middleware/renderAdmin');
        await renderAdmin(req, res, 'admin/priority-profiles', 'Duyệt hồ sơ ưu tiên', {
            profiles: profiles,
            path: 'priority-profiles' // Để menu sidebar sáng đúng mục
        });
    } catch (error) {
        console.error('Lỗi lấy hồ sơ ưu tiên:', error);
        res.status(500).send("Lỗi máy chủ nội bộ");
    }
};

// Chấp nhận hồ sơ
exports.approveProfile = async (req, res) => {
    try {
        const { userId } = req.params;
        await User.findByIdAndUpdate(userId, { "priorityProfile.status": 'APPROVED' });

        const user = await User.findById(userId);
        await sendEmail(user.email, "Hồ sơ ưu tiên đã được duyệt", "Chúc mừng! Hồ sơ ưu tiên BusDN của bạn đã được chấp nhận.");

        res.redirect('/admin/priority-profiles?success=Đã duyệt hồ sơ');
    } catch (error) {
        res.status(500).send('Lỗi duyệt hồ sơ');
    }
};

// Từ chối hồ sơ
exports.rejectProfile = async (req, res) => {
    try {
        const { userId } = req.params;
        await User.findByIdAndUpdate(userId, { "priorityProfile.status": 'REJECTED' });

        const user = await User.findById(userId);
        await sendEmail(user.email, "Hồ sơ ưu tiên bị từ chối", "Rất tiếc, hồ sơ ưu tiên của bạn không hợp lệ. Vui lòng kiểm tra lại ảnh thẻ.");

        res.redirect('/admin/priority-profiles?warning=Đã từ chối hồ sơ');
    } catch (error) {
        res.status(500).send('Lỗi từ chối hồ sơ');
    }
};