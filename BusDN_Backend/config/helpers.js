require('dotenv').config();
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ================= PASSWORD =================
const checkPassword = (password) => {
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return passwordRegex.test(password);
};

const PASS_ERR_MSG = "Mật khẩu phải có ít nhất 8 ký tự, bao gồm chữ hoa, chữ thường, số và ký tự đặc biệt (@$!%*?&).";

// ================= DATE =================
const formatDate = (date) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

// ================= EMAIL =================
const getMailTransporter = () => {
    const emailUser = (process.env.EMAIL_USER || '').trim();
    const emailPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');

    if (!emailUser || !emailPass) {
        throw new Error('Missing EMAIL_USER or EMAIL_PASS');
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });

    return {
        transporter,
        from: (process.env.EMAIL_FROM || emailUser).trim()
    };
};

const sendEmail = async (to, subject, htmlContent) => {
    console.log("🔥 SEND EMAIL CALLED:", to);

    try {
        const { transporter, from } = getMailTransporter();

        await transporter.verify();
        console.log("✅ SMTP READY");

        const info = await transporter.sendMail({
            from,
            to,
            subject,
            html: htmlContent
        });

        console.log("📧 SENT:", info.response);
        return true;

    } catch (error) {
        console.error("❌ MAIL ERROR FULL:", error);
        throw error; // 🔥 QUAN TRỌNG (đừng return false nữa)
    }
};

// ================= ROUTE =================
const parseRoutePayload = (body) => {
    const routeNumber = (body.routeNumber || "").trim().toUpperCase();
    const name = (body.name || "").trim();
    const description = (body.description || "").trim();
    const distanceRaw = String(body.distance ?? "").trim();
    const monthlyPassPriceRaw = String(body.monthlyPassPrice ?? "").trim();
    const startTime = (body.startTime || "").trim();
    const endTime = (body.endTime || "").trim();
    const status = (body.status || "ACTIVE").toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE";

    return {
        routeNumber,
        name,
        description,
        distanceRaw,
        distance: distanceRaw === "" ? null : Number(distanceRaw),
        monthlyPassPriceRaw,
        monthlyPassPrice: monthlyPassPriceRaw === "" ? null : Number(monthlyPassPriceRaw),
        startTime,
        endTime,
        status,
    };
};

const validateRoutePayload = (payload) => {
    const errors = [];
    if (!payload.routeNumber) errors.push("Vui lòng nhập mã tuyến.");
    if (!payload.name) errors.push("Vui lòng nhập tên tuyến.");
    if (payload.distanceRaw === "" || Number.isNaN(payload.distance) || payload.distance <= 0) {
        errors.push("Cự ly phải là số lớn hơn 0.");
    }
    return errors;
};

const routeListRedirect = (res, type, message) => {
    const q = new URLSearchParams();
    q.set(type, message);
    return res.redirect("/admin/routes?" + q.toString());
};

// ================= OTP =================
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const generateResetToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

// ================= EXPORT =================
module.exports = {
    parseRoutePayload,
    validateRoutePayload,
    routeListRedirect,
    checkPassword,
    PASS_ERR_MSG,
    sendEmail,
    formatDate,
    generateOTP,
    generateResetToken
};