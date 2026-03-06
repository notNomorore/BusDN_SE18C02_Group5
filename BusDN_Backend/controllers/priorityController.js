const path = require('path');
const fs = require('fs');
const { User, PriorityProfile, PriorityHistory } = require('../models/models');
const { sendEmail } = require('../config/helpers');
const {
    getMinPriorityExpiryDate,
    isExpiryDateValid,
    emitPendingPriorityCount
} = require('../utils/priorityUtils');

const getApprovalEmailHtml = (fullName, expiryDate) => `
<div style="font-family: Arial, sans-serif; background:#f4f7fb; padding:20px;">
  <div style="max-width:620px; margin:0 auto; background:#fff; border-radius:10px; padding:24px;">
    <h2 style="margin-top:0; color:#123d7a;">BusDN - Priority Approved</h2>
    <p>Xin chao <strong>${fullName}</strong>,</p>
    <p>Ho so uu tien cua ban da duoc phe duyet.</p>
    <p><strong>Uu dai:</strong> Giam gia co dinh 20% cho luong mua ve/ve thang khi trang thai uu tien con hieu luc.</p>
    <p><strong>Ngay het han:</strong> ${new Date(expiryDate).toLocaleDateString('vi-VN')}</p>
    <p>Ban co the dang nhap de su dung uu dai ngay bay gio.</p>
  </div>
</div>
`;

const getRejectedEmailHtml = (fullName, reason) => `
<div style="font-family: Arial, sans-serif; background:#f4f7fb; padding:20px;">
  <div style="max-width:620px; margin:0 auto; background:#fff; border-radius:10px; padding:24px;">
    <h2 style="margin-top:0; color:#7a1b12;">BusDN - Priority Rejected</h2>
    <p>Xin chao <strong>${fullName}</strong>,</p>
    <p>Ho so uu tien cua ban chua du dieu kien duoc phe duyet.</p>
    <p><strong>Ly do:</strong> ${reason}</p>
    <p>Ban co the cap nhat ho so va nop lai trong he thong.</p>
  </div>
</div>
`;

const syncUserPriorityPending = async (userId, profile) => {
    await User.findByIdAndUpdate(userId, {
        isPriorityGroup: false,
        priorityStatus: 'PENDING',
        priorityProfile: {
            cardImageFront: profile.idCardImageFront,
            cardImageBack: profile.idCardImageBack,
            cardNumber: profile.idNumber,
            status: 'PENDING',
            expiryDate: null
        }
    });
};

const syncUserPriorityApproved = async (userId, profile) => {
    await User.findByIdAndUpdate(userId, {
        isPriorityGroup: true,
        priorityStatus: 'APPROVED',
        priorityProfile: {
            cardImageFront: profile.idCardImageFront,
            cardImageBack: profile.idCardImageBack,
            cardNumber: profile.idNumber,
            status: 'APPROVED',
            expiryDate: profile.expiryDate
        }
    });
};

const syncUserPriorityRejected = async (userId, profile) => {
    await User.findByIdAndUpdate(userId, {
        isPriorityGroup: false,
        priorityStatus: 'REJECTED',
        priorityProfile: {
            cardImageFront: profile.idCardImageFront,
            cardImageBack: profile.idCardImageBack,
            cardNumber: profile.idNumber,
            status: 'REJECTED',
            expiryDate: null
        }
    });
};

exports.getRegisterForm = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.redirect('/login');
        }

        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).send('User not found');

        const profile = await PriorityProfile.findOne({ userId: req.session.userId });
        if (profile?.status === 'approved') {
            return res.redirect('/priority/view');
        }
        if (profile?.status === 'pending') {
            return res.redirect('/priority/status');
        }
        if (profile?.status === 'rejected') {
            return res.render('priority-register', {
                user,
                error: `Ho so truoc do da bi tu choi. Ly do: ${profile.rejectionReason}`,
                success: null,
                oldProfile: profile
            });
        }

        return res.render('priority-register', { user, error: null, success: null, oldProfile: null });
    } catch (error) {
        console.error('Error loading register form:', error);
        return res.status(500).send('Error loading page');
    }
};

exports.submitRegistration = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.redirect('/login');
        }

        const { category, idNumber } = req.body;
        const user = await User.findById(req.session.userId);

        if (!category || !idNumber) {
            return res.render('priority-register', {
                user,
                error: 'Vui long dien day du thong tin bat buoc.',
                success: null,
                oldProfile: null
            });
        }

        if (!req.files || !req.files.idCardFront || !req.files.idCardBack || !req.files.proofImage) {
            return res.render('priority-register', {
                user,
                error: 'Vui long tai len day du 3 anh giay to.',
                success: null,
                oldProfile: null
            });
        }

        let profile = await PriorityProfile.findOne({ userId: req.session.userId });
        if (profile?.status === 'pending') {
            return res.render('priority-register', {
                user,
                error: 'Ho so dang cho duyet. Vui long doi ket qua.',
                success: null,
                oldProfile: profile
            });
        }

        if (profile) {
            deleteOldFiles(profile);
        }

        const profileData = {
            userId: req.session.userId,
            category,
            idNumber,
            idCardImageFront: `/uploads/priority/${req.files.idCardFront[0].filename}`,
            idCardImageBack: `/uploads/priority/${req.files.idCardBack[0].filename}`,
            proofImage: `/uploads/priority/${req.files.proofImage[0].filename}`,
            status: 'pending',
            rejectionReason: null,
            expiryDate: null
        };

        if (profile) {
            profile = await PriorityProfile.findByIdAndUpdate(profile._id, profileData, { new: true });
        } else {
            profile = await PriorityProfile.create(profileData);
        }

        await syncUserPriorityPending(req.session.userId, profile);
        await emitPendingPriorityCount();

        if (user?.email) {
            await sendEmail(
                user.email,
                'BusDN - Ho so uu tien da duoc tiep nhan',
                `<p>Xin chao ${user.fullName}, ho so uu tien cua ban da duoc tiep nhan va dang cho duyet.</p>`
            );
        }

        return res.render('priority-status', {
            user,
            profile,
            message: 'Ho so uu tien da duoc gui. Admin se xu ly som.'
        });
    } catch (error) {
        console.error('Error submitting registration:', error);
        if (req.files) {
            deleteUploadedFiles(req.files);
        }

        const user = await User.findById(req.session.userId);
        return res.render('priority-register', {
            user,
            error: 'Khong the gui ho so: ' + error.message,
            success: null,
            oldProfile: null
        });
    }
};

exports.getStatus = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.redirect('/login');
        }
        const user = await User.findById(req.session.userId);
        const profile = await PriorityProfile.findOne({ userId: req.session.userId });
        if (!profile) {
            return res.redirect('/priority/register');
        }
        return res.render('priority-status', { user, profile, message: null });
    } catch (error) {
        console.error('Error loading status:', error);
        return res.status(500).send('Error loading page');
    }
};

exports.viewProfile = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.redirect('/login');
        }
        const user = await User.findById(req.session.userId);
        const profile = await PriorityProfile.findOne({ userId: req.session.userId });
        if (!profile || profile.status !== 'approved') {
            return res.redirect('/priority/register');
        }
        return res.render('priority-view', { user, profile });
    } catch (error) {
        console.error('Error loading profile:', error);
        return res.status(500).send('Error loading page');
    }
};

exports.listProfiles = async (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        const filter = {};
        if (['pending', 'approved', 'rejected'].includes(status)) {
            filter.status = status;
        }

        const profiles = await PriorityProfile.find(filter)
            .populate('userId', 'fullName email phone')
            .sort({ createdAt: -1 });

        const { renderAdmin } = require('../middleware/renderAdmin');
        return renderAdmin(req, res, 'admin/priority-profiles', 'Quan ly Ho so Uu tien', {
            profiles,
            currentStatus: status,
            path: 'priority-profiles'
        });
    } catch (error) {
        console.error('Error listing profiles:', error);
        return res.status(500).send('Error loading profiles');
    }
};

exports.viewProfileDetail = async (req, res) => {
    try {
        const { profileId } = req.params;
        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) {
            return res.status(404).send('Profile not found');
        }

        const minExpiryDate = getMinPriorityExpiryDate(new Date());
        const { renderAdmin } = require('../middleware/renderAdmin');
        return renderAdmin(req, res, 'admin/priority-detail', 'Chi tiet Ho so Uu tien', {
            profile,
            minExpiryDate: minExpiryDate.toISOString().split('T')[0],
            path: 'priority-profiles'
        });
    } catch (error) {
        console.error('Error loading profile detail:', error);
        return res.status(500).send('Error loading profile');
    }
};

exports.approveProfile = async (req, res) => {
    try {
        const { profileId } = req.params;
        const approvalDate = new Date();
        const minExpiryDate = getMinPriorityExpiryDate(approvalDate);

        let parsedExpiry = req.body?.expiryDate ? new Date(req.body.expiryDate) : minExpiryDate;
        if (Number.isNaN(parsedExpiry.getTime())) {
            return res.status(400).json({ error: 'Ngay het han khong hop le.' });
        }
        parsedExpiry.setHours(0, 0, 0, 0);

        if (!isExpiryDateValid(parsedExpiry, approvalDate)) {
            return res.status(400).json({
                error: `Ngay het han phai tu ${minExpiryDate.toLocaleDateString('vi-VN')} tro di.`
            });
        }

        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        profile.status = 'approved';
        profile.expiryDate = parsedExpiry;
        profile.rejectionReason = null;
        await profile.save();
        await syncUserPriorityApproved(profile.userId._id, profile);

        if (profile.userId?.email) {
            await sendEmail(
                profile.userId.email,
                'BusDN - Ho so uu tien da duoc phe duyet',
                getApprovalEmailHtml(profile.userId.fullName, parsedExpiry)
            );
        }

        await emitPendingPriorityCount();
        return res.json({ success: true, message: 'Profile approved successfully' });
    } catch (error) {
        console.error('Error approving profile:', error);
        return res.status(500).json({ error: 'Error approving profile' });
    }
};

exports.rejectProfile = async (req, res) => {
    try {
        const { profileId } = req.params;
        const rejectionReason = (req.body?.rejectionReason || '').trim();
        if (!rejectionReason) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }

        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        profile.status = 'rejected';
        profile.rejectionReason = rejectionReason;
        profile.expiryDate = null;
        await profile.save();
        await syncUserPriorityRejected(profile.userId._id, profile);

        await PriorityHistory.create({
            userId: profile.userId._id,
            profileId: profile._id,
            action: 'REJECTED',
            rejectedBy: req.session.userId,
            reason: rejectionReason,
            timestamp: new Date()
        });

        if (profile.userId?.email) {
            await sendEmail(
                profile.userId.email,
                'BusDN - Ho so uu tien bi tu choi',
                getRejectedEmailHtml(profile.userId.fullName, rejectionReason)
            );
        }

        await emitPendingPriorityCount();
        return res.json({ success: true, message: 'Profile rejected successfully' });
    } catch (error) {
        console.error('Error rejecting profile:', error);
        return res.status(500).json({ error: 'Error rejecting profile' });
    }
};

const deleteOldFiles = (profile) => {
    const filePaths = [
        profile.idCardImageFront,
        profile.idCardImageBack,
        profile.proofImage
    ];

    filePaths.forEach((filePath) => {
        if (!filePath) return;
        const fullPath = path.join(__dirname, '../public', filePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    });
};

const deleteUploadedFiles = (files) => {
    const map = ['idCardFront', 'idCardBack', 'proofImage'];
    map.forEach((key) => {
        if (!files[key]?.[0]?.filename) return;
        const fullPath = path.join(__dirname, '../public/uploads/priority', files[key][0].filename);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    });
};
