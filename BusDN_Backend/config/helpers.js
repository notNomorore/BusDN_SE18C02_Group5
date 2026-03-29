require('dotenv').config();
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ================= PASSWORD =================
const checkPassword = (password) => {
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return passwordRegex.test(password);
};

const PASS_ERR_MSG = 'Mat khau phai co it nhat 8 ky tu, bao gom chu hoa, chu thuong, so va ky tu dac biet (@$!%*?&).';

// ================= DATE =================
const formatDate = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

// ================= EMAIL =================
const stripWrappingQuotes = (value) => {
    let raw = String(value || '').trim();
    if (
        (raw.startsWith('"') && raw.endsWith('"'))
        || (raw.startsWith("'") && raw.endsWith("'"))
    ) {
        raw = raw.slice(1, -1).trim();
    }
    return raw;
};

const parseBooleanEnv = (value, fallback = false) => {
    const normalized = stripWrappingQuotes(value).toLowerCase();
    if (!normalized) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
};

const maskEmail = (value) => {
    const email = stripWrappingQuotes(value);
    const [localPart, domainPart] = email.split('@');
    if (!localPart || !domainPart) return email || '(empty)';
    if (localPart.length <= 2) return `${localPart[0] || '*'}*@${domainPart}`;
    return `${localPart.slice(0, 2)}***@${domainPart}`;
};

const buildMailConfig = () => {
    const emailUser = stripWrappingQuotes(process.env.EMAIL_USER).toLowerCase();
    const emailPass = stripWrappingQuotes(process.env.EMAIL_PASS).replace(/\s+/g, '');
    const emailFrom = stripWrappingQuotes(process.env.EMAIL_FROM || emailUser) || emailUser;
    const service = stripWrappingQuotes(process.env.SMTP_SERVICE);
    const host = stripWrappingQuotes(process.env.SMTP_HOST || 'smtp.gmail.com');
    const port = Number(stripWrappingQuotes(process.env.SMTP_PORT || '465')) || 465;
    const secure = parseBooleanEnv(process.env.SMTP_SECURE, port === 465);
    const debug = parseBooleanEnv(process.env.EMAIL_DEBUG, false);

    if (!emailUser || !emailPass) {
        throw new Error('Missing EMAIL_USER or EMAIL_PASS');
    }

    return {
        emailUser,
        emailPass,
        emailFrom,
        service,
        host,
        port,
        secure,
        debug
    };
};

const getMailTransporter = () => {
    const mailConfig = buildMailConfig();
    const transportOptions = {
        auth: {
            user: mailConfig.emailUser,
            pass: mailConfig.emailPass
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
    };

    if (mailConfig.service) {
        transportOptions.service = mailConfig.service;
    } else {
        transportOptions.host = mailConfig.host;
        transportOptions.port = mailConfig.port;
        transportOptions.secure = mailConfig.secure;
    }

    if (mailConfig.debug) {
        transportOptions.logger = true;
        transportOptions.debug = true;
    }

    return {
        transporter: nodemailer.createTransport(transportOptions),
        from: mailConfig.emailFrom,
        summary: {
            user: maskEmail(mailConfig.emailUser),
            from: maskEmail(mailConfig.emailFrom),
            mode: mailConfig.service ? `service:${mailConfig.service}` : `${mailConfig.host}:${mailConfig.port}`,
            secure: mailConfig.secure
        }
    };
};

const sendEmail = async (to, subject, htmlContent) => {
    const mailRequestId = crypto.randomBytes(4).toString('hex');
    const safeTo = stripWrappingQuotes(to).toLowerCase();

    console.log(`[mail:${mailRequestId}] send-start to=${safeTo || '(empty)'} subject="${String(subject || '').trim()}"`);

    try {
        const { transporter, from, summary } = getMailTransporter();
        console.log(`[mail:${mailRequestId}] transport`, summary);

        const info = await transporter.sendMail({
            from,
            to: safeTo,
            subject,
            html: htmlContent
        });

        console.log(
            `[mail:${mailRequestId}] send-ok messageId=${info.messageId || 'n/a'} response=${info.response || 'n/a'}`
        );
        return true;
    } catch (error) {
        console.error(`[mail:${mailRequestId}] send-failed`, {
            message: error?.message || 'Unknown mail error',
            code: error?.code || null,
            command: error?.command || null,
            responseCode: error?.responseCode || null,
            response: error?.response || null
        });
        throw error;
    }
};

// ================= ROUTE =================
const parseRoutePayload = (body) => {
    const routeNumber = (body.routeNumber || '').trim().toUpperCase();
    const name = (body.name || '').trim();
    const description = (body.description || '').trim();
    const distanceRaw = String(body.distance ?? '').trim();
    const monthlyPassPriceRaw = String(body.monthlyPassPrice ?? '').trim();
    const startTime = (body.startTime || '').trim();
    const endTime = (body.endTime || '').trim();
    const status = (body.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

    return {
        routeNumber,
        name,
        description,
        distanceRaw,
        distance: distanceRaw === '' ? null : Number(distanceRaw),
        monthlyPassPriceRaw,
        monthlyPassPrice: monthlyPassPriceRaw === '' ? null : Number(monthlyPassPriceRaw),
        startTime,
        endTime,
        status
    };
};

const validateRoutePayload = (payload) => {
    const errors = [];
    if (!payload.routeNumber) errors.push('Vui long nhap ma tuyen.');
    if (!payload.name) errors.push('Vui long nhap ten tuyen.');
    if (payload.distanceRaw === '' || Number.isNaN(payload.distance) || payload.distance <= 0) {
        errors.push('Cu ly phai la so lon hon 0.');
    }
    return errors;
};

const routeListRedirect = (res, type, message) => {
    const q = new URLSearchParams();
    q.set(type, message);
    return res.redirect('/admin/routes?' + q.toString());
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
