const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { User, PriorityProfile } = require('../models/models');
require('dotenv').config();
// --- NODEMAILER CONFIGURATION ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER ,
        pass: process.env.EMAIL_PASS
    }
});

// --- EMAIL HELPER ---
const sendEmail = async (to, subject, htmlContent) => {
    try {
        await transporter.sendMail({
            from: '"BusDN Admin"',
            to: to,
            subject: subject,
            html: htmlContent
        });
        console.log(`✅ Email sent to ${to}`);
    } catch (error) {
        console.error('❌ Error sending email:', error);
    }
};

// --- USER CONTROLLERS ---

/**
 * GET /priority/register - Show registration form
 * Check existing profile status and render appropriate view
 */
exports.getRegisterForm = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.redirect('/login');
        }

        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).send('User not found');

        // Check if priority profile exists
        const profile = await PriorityProfile.findOne({ userId: req.session.userId });

        // If profile exists and is approved, redirect to profile
        if (profile && profile.status === 'approved') {
            return res.redirect('/priority/view');
        }

        // If profile exists and is pending, show status page
        if (profile && profile.status === 'pending') {
            return res.redirect('/priority/status');
        }

        // If profile exists and is rejected, show form with rejection reason
        if (profile && profile.status === 'rejected') {
            return res.render('priority-register', {
                user,
                error: `Your previous application was rejected. Reason: ${profile.rejectionReason}`,
                success: null,
                oldProfile: profile
            });
        }

        // Otherwise, show the registration form
        res.render('priority-register', { user, error: null, success: null, oldProfile: null });
    } catch (error) {
        console.error('Error loading register form:', error);
        res.status(500).send('Error loading page');
    }
};

/**
 * POST /priority/register - Submit priority profile registration
 * Expects: category, idNumber, files (idCardFront, idCardBack, proofImage)
 */
exports.submitRegistration = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.redirect('/login');
        }

        const { category, idNumber } = req.body;
        const user = await User.findById(req.session.userId);

        // Validation
        if (!category || !idNumber) {
            return res.render('priority-register', {
                user,
                error: 'Please fill in all required fields',
                success: null,
                oldProfile: null
            });
        }

        if (!req.files || !req.files.idCardFront || !req.files.idCardBack || !req.files.proofImage) {
            return res.render('priority-register', {
                user,
                error: 'Please upload all three required images',
                success: null,
                oldProfile: null
            });
        }

        // Check if profile already exists
        let profile = await PriorityProfile.findOne({ userId: req.session.userId });

        if (profile && profile.status === 'pending') {
            return res.render('priority-register', {
                user,
                error: 'Your application is still being reviewed. Please wait.',
                success: null,
                oldProfile: profile
            });
        }

        // If existing profile, delete old files
        if (profile) {
            deleteOldFiles(profile);
        }

        // Create or update profile
        const profileData = {
            userId: req.session.userId,
            category,
            idNumber,
            idCardImageFront: '/uploads/priority/' + req.files.idCardFront[0].filename,
            idCardImageBack: '/uploads/priority/' + req.files.idCardBack[0].filename,
            proofImage: '/uploads/priority/' + req.files.proofImage[0].filename,
            status: 'pending',
            rejectionReason: null,
            expiryDate: null
        };

        if (profile) {
            // Update existing
            profile = await PriorityProfile.findByIdAndUpdate(profile._id, profileData, { new: true });
        } else {
            // Create new
            profile = new PriorityProfile(profileData);
            await profile.save();
        }

        // Send confirmation email to user
        await sendNotificationEmail(user, 'submitted');

        res.render('priority-status', {
            user,
            profile,
            message: 'Your priority profile has been submitted successfully! Our admin team will review it shortly.'
        });
    } catch (error) {
        console.error('Error submitting registration:', error);

        if (req.files) {
            deleteUploadedFiles(req.files);
        }

        const user = await User.findById(req.session.userId);
        res.render('priority-register', {
            user,
            error: 'Error submitting profile: ' + error.message,
            success: null,
            oldProfile: null
        });
    }
};

/**
 * GET /priority/status - Show status of priority profile
 */
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

        res.render('priority-status', { user, profile, message: null });
    } catch (error) {
        console.error('Error loading status:', error);
        res.status(500).send('Error loading page');
    }
};

/**
 * GET /priority/view - View approved priority profile
 */
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

        res.render('priority-view', { user, profile });
    } catch (error) {
        console.error('Error loading profile:', error);
        res.status(500).send('Error loading page');
    }
};

// --- ADMIN CONTROLLERS ---

/**
 * GET /admin/priority-profiles - List all priority profiles
 */
exports.listProfiles = async (req, res) => {
    try {
        const { status = 'pending' } = req.query;

        let filter = {};
        if (status && ['pending', 'approved', 'rejected'].includes(status)) {
            filter.status = status;
        }

        const profiles = await PriorityProfile.find(filter)
            .populate('userId', 'fullName email phone')
            .sort({ createdAt: -1 });

        const { renderAdmin } = require('../middleware/renderAdmin');
        await renderAdmin(req, res, 'admin/priority-profiles', 'Quản lý Hồ sơ Ưu tiên', {
            profiles,
            currentStatus: status,
            path: 'priority-profiles'
        });
    } catch (error) {
        console.error('Error listing profiles:', error);
        res.status(500).send('Error loading profiles');
    }
};

/**
 * GET /admin/priority-profiles/:profileId - View profile details
 */
exports.viewProfileDetail = async (req, res) => {
    try {
        const { profileId } = req.params;
        const profile = await PriorityProfile.findById(profileId).populate('userId');

        if (!profile) {
            return res.status(404).send('Profile not found');
        }

        const { renderAdmin } = require('../middleware/renderAdmin');
        await renderAdmin(req, res, 'admin/priority-detail', 'Chi tiết hồ sơ ưu tiên', {
            profile,
            path: 'priority-profiles'
        });
    } catch (error) {
        console.error('Error loading profile detail:', error);
        res.status(500).send('Error loading profile');
    }
};

/**
 * POST /admin/priority-profiles/:profileId/approve - Approve profile
 * Expects: expiryDate (optional, defaults to 2 years from now)
 */
exports.approveProfile = async (req, res) => {
    try {
        const { profileId } = req.params;
        let { expiryDate } = req.body;

        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // If no expiry date provided, set to 2 years from now
        if (!expiryDate) {
            const tomorrow = new Date();
            tomorrow.setFullYear(tomorrow.getFullYear() + 2);
            expiryDate = tomorrow;
        } else {
            expiryDate = new Date(expiryDate);
        }

        if (Number.isNaN(expiryDate.getTime())) {
            return res.status(400).json({ error: 'Expiry date is invalid' });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expiryDate.setHours(0, 0, 0, 0);
        if (expiryDate < today) {
            return res.status(400).json({ error: 'Expiry date cannot be in the past' });
        }

        // Update profile
        profile.status = 'approved';
        profile.expiryDate = expiryDate;
        await profile.save();

        // Send approval email to user
        await sendNotificationEmail(profile.userId, 'approved', expiryDate);

        console.log(`✅ Profile ${profileId} approved - Expiry: ${expiryDate}`);
        res.json({ success: true, message: 'Profile approved successfully' });
    } catch (error) {
        console.error('Error approving profile:', error);
        res.status(500).json({ error: 'Error approving profile' });
    }
};

/**
 * POST /admin/priority-profiles/:profileId/reject - Reject profile
 * Expects: rejectionReason
 */
exports.rejectProfile = async (req, res) => {
    try {
        const { profileId } = req.params;
        const { rejectionReason } = req.body;

        if (!rejectionReason) {
            return res.status(400).json({ error: 'Rejection reason is required' });
        }

        const profile = await PriorityProfile.findById(profileId).populate('userId');
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Update profile
        profile.status = 'rejected';
        profile.rejectionReason = rejectionReason;
        await profile.save();

        // Send rejection email to user
        await sendNotificationEmail(profile.userId, 'rejected', null, rejectionReason);

        console.log(`✅ Profile ${profileId} rejected - Reason: ${rejectionReason}`);
        res.json({ success: true, message: 'Profile rejected successfully' });
    } catch (error) {
        console.error('Error rejecting profile:', error);
        res.status(500).json({ error: 'Error rejecting profile' });
    }
};

// --- HELPER FUNCTIONS ---

/**
 * Send email notifications for profile status changes
 */
const sendNotificationEmail = async (user, action, expiryDate = null, rejectionReason = null) => {
    let subject, htmlContent;

    if (action === 'submitted') {
        subject = 'BusDN - Priority Profile Submitted';
        htmlContent = getEmailTemplate('submitted', user.fullName);
    } else if (action === 'approved') {
        subject = 'BusDN - Your Priority Profile Approved ✅';
        htmlContent = getEmailTemplate('approved', user.fullName, expiryDate);
    } else if (action === 'rejected') {
        subject = 'BusDN - Priority Profile Update ℹ️';
        htmlContent = getEmailTemplate('rejected', user.fullName, null, rejectionReason);
    }

    await sendEmail(user.email, subject, htmlContent);
};

/**
 * Generate HTML email template
 */
const getEmailTemplate = (type, fullName, expiryDate = null, rejectionReason = null) => {
    const currentYear = new Date().getFullYear();

    let content = '';

    if (type === 'submitted') {
        content = `
            <p>Dear ${fullName},</p>
            <p>Thank you for submitting your priority profile application to BusDN.</p>
            <p>We have received your documents and our admin team will review them shortly.</p>
            <p><strong>You will receive another email once your application has been reviewed.</strong></p>
        `;
    } else if (type === 'approved') {
        const expiryStr = new Date(expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        content = `
            <p>Dear ${fullName},</p>
            <p><strong style="color: #28a745; font-size: 18px;">🎉 Congratulations!</strong></p>
            <p>Your priority profile has been <strong>approved</strong> and is now <strong>active</strong>.</p>
            <p>You are now eligible for discounted fares on BusDN services.</p>
            <div style="background-color: #e8f5e9; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0;">
                <p style="margin: 5px 0;"><strong>Expiry Date:</strong> <span style="color: #28a745;">${expiryStr}</span></p>
                <p style="margin: 5px 0; font-size: 12px;">Your priority status will expire on the date shown above.</p>
            </div>
            <p><a href="http://localhost:3000/priority/view" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">View My Priority Profile</a></p>
        `;
    } else if (type === 'rejected') {
        content = `
            <p>Dear ${fullName},</p>
            <p>Thank you for submitting your priority profile application to BusDN.</p>
            <p>Unfortunately, your application has been <strong>declined</strong>. Here's why:</p>
            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
                <p>${rejectionReason}</p>
            </div>
            <p>You can <strong>resubmit your application</strong> with corrected documents.</p>
            <p><a href="http://localhost:3000/priority/register" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Resubmit Application</a></p>
        `;
    }

    return `
        <html>
            <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px;">
                <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <div style="border-bottom: 3px solid #003366; padding-bottom: 20px; margin-bottom: 30px;">
                        <h1 style="color: #003366; margin: 0; font-size: 24px;">
                            <i style="color: #ffc107;">🚌</i> BusDN
                        </h1>
                    </div>

                    <!-- Main Content -->
                    <div style="color: #333; line-height: 1.6; font-size: 14px;">
                        ${content}
                    </div>

                    <!-- Footer -->
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 40px 0;">
                    <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">
                        © ${currentYear} BusDN - Bus Management System<br>
                        If you have any questions, please contact our support team.
                    </p>
                </div>
            </body>
        </html>
    `;
};

/**
 * Delete old uploaded files
 */
const deleteOldFiles = (profile) => {
    const filePaths = [
        profile.idCardImageFront,
        profile.idCardImageBack,
        profile.proofImage
    ];

    filePaths.forEach(filePath => {
        if (filePath) {
            const fullPath = path.join(__dirname, '../public', filePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                console.log(`✅ Deleted old file: ${fullPath}`);
            }
        }
    });
};

/**
 * Delete uploaded files in case of error
 */
const deleteUploadedFiles = (files) => {
    if (files.idCardFront) {
        const fullPath = path.join(__dirname, '../public/uploads/priority', files.idCardFront[0].filename);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    if (files.idCardBack) {
        const fullPath = path.join(__dirname, '../public/uploads/priority', files.idCardBack[0].filename);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    if (files.proofImage) {
        const fullPath = path.join(__dirname, '../public/uploads/priority', files.proofImage[0].filename);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
};
