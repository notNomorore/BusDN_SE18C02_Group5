require('dotenv').config();

const checkPassword = (password) => {
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return passwordRegex.test(password);
};
const PASS_ERR_MSG = "Mật khẩu phải có ít nhất 8 ký tự, bao gồm chữ hoa, chữ thường, số và ký tự đặc biệt (@$!%*?&).";
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
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS         
    }
});

const sendEmail = async (to, subject, htmlContent) => {
    try {
        await transporter.sendMail({
            from: '"BusDN Admin"',
            to,
            subject,
            html: htmlContent
        });
        return true;
    } catch (error) {
        console.error('❌ Lỗi gửi mail:', error);
        return false;
    }
};

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
        routeNumber, name, description, distanceRaw,
        distance: distanceRaw === "" ? null : Number(distanceRaw),
        monthlyPassPriceRaw,
        monthlyPassPrice: monthlyPassPriceRaw === "" ? null : Number(monthlyPassPriceRaw),
        startTime, endTime, status,
    };
};

const validateRoutePayload = (payload, { requireTime = false } = {}) => {
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

module.exports = { 
    parseRoutePayload, 
    validateRoutePayload, 
    routeListRedirect, 
    checkPassword,
    PASS_ERR_MSG,
    sendEmail,
    formatDate };