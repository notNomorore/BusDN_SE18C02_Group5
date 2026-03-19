const { User, Route, MonthlyPass, WalletTransaction, Promotion } = require("../models/models");
const { PRIORITY_DISCOUNT_RATE, applyPriorityExpiryForUser, applyPriorityDiscount } = require("../utils/priorityUtils");
const crypto = require("crypto");
const querystring = require("querystring");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const {
    getFareMatrix,
    getPriorityDiscountPercentByCategory,
    resolveMonthlyPassBasePrice
} = require("../services/fareMatrixService");

const PASS_TYPE = {
    SINGLE_ROUTE: "SINGLE_ROUTE",
    INTER_ROUTE: "INTER_ROUTE"
};

const PAYMENT_METHOD = {
    VNPAY: "VNPAY",
    MOMO: "MOMO"
};

const PROMO_RESERVATION_TTL_MINUTES = 20;

function isPassenger(req) {
    return req.session?.userId && req.session?.role === "PASSENGER";
}

function parsePositiveInt(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function parseMonthInput(monthStr) {
    if (!/^\d{4}-\d{2}$/.test(monthStr || "")) return null;
    const [year, month] = monthStr.split("-").map(Number);
    if (!year || !month || month < 1 || month > 12) return null;
    return { year, month };
}

function getMonthDateRange(year, month) {
    const validFrom = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const validTo = new Date(year, month, 0, 23, 59, 59, 999);
    return { validFrom, validTo };
}

function makePassCode(year, month, userId, passType) {
    const mm = String(month).padStart(2, "0");
    const shortUser = String(userId).slice(-6).toUpperCase();
    const rand = Math.floor(Math.random() * 9000 + 1000);
    const typePrefix = passType === PASS_TYPE.INTER_ROUTE ? "LT" : "DT";
    return `MP-${typePrefix}-${year}${mm}-${shortUser}-${rand}`;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function parsePassType(value) {
    return value === PASS_TYPE.INTER_ROUTE ? PASS_TYPE.INTER_ROUTE : PASS_TYPE.SINGLE_ROUTE;
}

function parsePaymentMethod(value) {
    return value === PAYMENT_METHOD.MOMO ? PAYMENT_METHOD.MOMO : PAYMENT_METHOD.VNPAY;
}

function normalizeDiscountPercent(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

function normalizePromoCode(value) {
    const code = String(value || "").trim().toUpperCase();
    return code || "";
}

function fixMojibakeVi(value) {
    const s = String(value || "");
    if (!s || (!s.includes("Ã") && !s.includes("Â"))) return s;
    try {
        return Buffer.from(s, "latin1").toString("utf8");
    } catch (err) {
        return s;
    }
}

async function getPriorityDiscountInfo(userId, fareMatrix) {
    const fallbackNone = {
        eligible: false,
        category: null,
        discountPercent: 0
    };

    try {
        const now = new Date();

        // 1) New flow: priorityprofiles collection
        const col = mongoose.connection.collection("priorityprofiles");
        const doc = await col.findOne(
            {
                userId: new mongoose.Types.ObjectId(String(userId)),
                status: { $in: ["approved", "APPROVED"] },
                $or: [{ expiryDate: null }, { expiryDate: { $gte: now } }]
            },
            { sort: { updatedAt: -1, createdAt: -1 } }
        );

        if (doc) {
            return {
                eligible: true,
                category: doc.category || null,
                discountPercent: getPriorityDiscountPercentByCategory(doc.category, fareMatrix)
            };
        }

        // 2) Legacy flow: User.priorityProfile
        const user = await User.findById(userId).select("priorityProfile").lean();
        const legacyStatus = String(user?.priorityProfile?.status || "").toUpperCase();
        const legacyExpiry = user?.priorityProfile?.expiryDate
            ? new Date(user.priorityProfile.expiryDate)
            : null;
        const legacyNotExpired = !legacyExpiry || legacyExpiry >= now;

        if (legacyStatus === "APPROVED" && legacyNotExpired) {
            return {
                eligible: true,
                category: null,
                discountPercent: getPriorityDiscountPercentByCategory("other", fareMatrix)
            };
        }

        return fallbackNone;
    } catch (err) {
        return fallbackNone;
    }
}

function formatQrDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleDateString("vi-VN");
}

function buildPassQrPayload(pass) {
    return JSON.stringify({
        provider: "BUSDN",
        passCode: pass.passCode,
        passType: pass.displayPassType,
        route: pass.displayRouteNumber
            ? `${pass.displayRouteNumber} - ${pass.displayRouteName}`
            : pass.displayRouteName,
        period: `${pad2(pass.month)}/${pass.year}`,
        validFrom: formatQrDate(pass.validFrom),
        validTo: formatQrDate(pass.validTo),
        pricePaid: Number(pass.pricePaid || 0),
        status: pass.status
    });
}

async function generatePassQrDataUrl(pass) {
    try {
        return await QRCode.toDataURL(buildPassQrPayload(pass), {
            width: 180,
            margin: 1,
            errorCorrectionLevel: "M"
        });
    } catch (err) {
        return "";
    }
}

function calcPromotionDiscount(orderAmount, promotion) {
    const amount = Number(orderAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0 || !promotion) return 0;

    let discount = 0;
    if (promotion.discountType === "PERCENT") {
        discount = Math.round((amount * Number(promotion.discountValue || 0)) / 100);
    } else {
        discount = Math.round(Number(promotion.discountValue || 0));
    }

    if (Number.isFinite(promotion.maxDiscountValue) && Number(promotion.maxDiscountValue) >= 0) {
        discount = Math.min(discount, Number(promotion.maxDiscountValue));
    }

    return Math.max(0, Math.min(discount, amount));
}

async function validateAndReservePromotion({
    promoCode,
    userId,
    passType,
    routeId,
    baseForPromo,
    now
}) {
    const empty = { promotion: null, discountAmount: 0 };
    if (!promoCode) return empty;

    const promotion = await Promotion.findOne({ code: promoCode }).lean();
    if (!promotion) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 kh\u00f4ng t\u1ed3n t\u1ea1i.");
    }

    if (promotion.status !== "ACTIVE") {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 ch\u01b0a ho\u1eb7c kh\u00f4ng c\u00f2n ho\u1ea1t \u0111\u1ed9ng.");
    }

    const startAt = promotion.startAt ? new Date(promotion.startAt) : null;
    const endAt = promotion.endAt ? new Date(promotion.endAt) : null;
    if (!startAt || !endAt || now < startAt || now > endAt) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 \u0111\u00e3 h\u1ebft h\u1ea1n ho\u1eb7c ch\u01b0a \u0111\u1ebfn th\u1eddi gian \u00e1p d\u1ee5ng.");
    }

    if (promotion.minOrderValue && baseForPromo < Number(promotion.minOrderValue)) {
        throw new Error(`\u0110\u01a1n h\u00e0ng ch\u01b0a \u0111\u1ea1t gi\u00e1 tr\u1ecb t\u1ed1i thi\u1ec3u ${Number(promotion.minOrderValue).toLocaleString("vi-VN")} \u0111.`);
    }

    if (promotion.applyScope === "INTER_ROUTE" && passType !== PASS_TYPE.INTER_ROUTE) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 ch\u1ec9 \u00e1p d\u1ee5ng cho v\u00e9 li\u00ean tuy\u1ebfn.");
    }

    if (promotion.applyScope === "SINGLE_ROUTE") {
        if (passType !== PASS_TYPE.SINGLE_ROUTE) {
            throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 ch\u1ec9 \u00e1p d\u1ee5ng cho v\u00e9 \u0111\u01a1n tuy\u1ebfn.");
        }
        if (!promotion.routeId || String(promotion.routeId) !== String(routeId || "")) {
            throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 kh\u00f4ng \u00e1p d\u1ee5ng cho tuy\u1ebfn \u0111\u00e3 ch\u1ecdn.");
        }
    }

    if (promotion.usageLimitPerUser) {
        const usedByUser = await WalletTransaction.countDocuments({
            userId,
            txnType: "MONTHLY_PASS",
            status: "SUCCESS",
            "rawReturn.promotionId": String(promotion._id)
        });
        if (usedByUser >= Number(promotion.usageLimitPerUser)) {
            throw new Error("B\u1ea1n \u0111\u00e3 d\u00f9ng h\u1ebft l\u01b0\u1ee3t c\u1ee7a m\u00e3 gi\u1ea3m gi\u00e1 n\u00e0y.");
        }
    }

    const reserveFilter = {
        _id: promotion._id,
        status: "ACTIVE",
        startAt: { $lte: now },
        endAt: { $gte: now }
    };
    if (promotion.usageLimitTotal) {
        reserveFilter.usageCount = { $lt: Number(promotion.usageLimitTotal) };
    }

    const reservedPromotion = await Promotion.findOneAndUpdate(
        reserveFilter,
        { $inc: { usageCount: 1 } },
        { new: true }
    ).lean();

    if (!reservedPromotion) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 \u0111\u00e3 h\u1ebft l\u01b0\u1ee3t s\u1eed d\u1ee5ng.");
    }

    const discountAmount = calcPromotionDiscount(baseForPromo, reservedPromotion);
    if (discountAmount <= 0) {
        await Promotion.updateOne(
            { _id: promotion._id, usageCount: { $gt: 0 } },
            { $inc: { usageCount: -1 } }
        );
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 kh\u00f4ng \u00e1p d\u1ee5ng cho \u0111\u01a1n h\u00e0ng hi\u1ec7n t\u1ea1i.");
    }

    return { promotion: reservedPromotion, discountAmount };
}
async function validatePromotionWithoutReserve({
    promoCode,
    userId,
    passType,
    routeId,
    baseForPromo,
    now
}) {
    if (!promoCode) {
        return { promotion: null, discountAmount: 0 };
    }

    const promotion = await Promotion.findOne({ code: promoCode }).lean();
    if (!promotion) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 kh\u00f4ng t\u1ed3n t\u1ea1i.");
    }
    if (promotion.status !== "ACTIVE") {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 ch\u01b0a ho\u1eb7c kh\u00f4ng c\u00f2n ho\u1ea1t \u0111\u1ed9ng.");
    }

    const startAt = promotion.startAt ? new Date(promotion.startAt) : null;
    const endAt = promotion.endAt ? new Date(promotion.endAt) : null;
    if (!startAt || !endAt || now < startAt || now > endAt) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 \u0111\u00e3 h\u1ebft h\u1ea1n ho\u1eb7c ch\u01b0a \u0111\u1ebfn th\u1eddi gian \u00e1p d\u1ee5ng.");
    }

    if (promotion.minOrderValue && baseForPromo < Number(promotion.minOrderValue)) {
        throw new Error(`\u0110\u01a1n h\u00e0ng ch\u01b0a \u0111\u1ea1t gi\u00e1 tr\u1ecb t\u1ed1i thi\u1ec3u ${Number(promotion.minOrderValue).toLocaleString("vi-VN")} \u0111.`);
    }

    if (promotion.applyScope === "INTER_ROUTE" && passType !== PASS_TYPE.INTER_ROUTE) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 ch\u1ec9 \u00e1p d\u1ee5ng cho v\u00e9 li\u00ean tuy\u1ebfn.");
    }

    if (promotion.applyScope === "SINGLE_ROUTE") {
        if (passType !== PASS_TYPE.SINGLE_ROUTE) {
            throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 ch\u1ec9 \u00e1p d\u1ee5ng cho v\u00e9 \u0111\u01a1n tuy\u1ebfn.");
        }
        if (!promotion.routeId || String(promotion.routeId) !== String(routeId || "")) {
            throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 kh\u00f4ng \u00e1p d\u1ee5ng cho tuy\u1ebfn \u0111\u00e3 ch\u1ecdn.");
        }
    }

    if (promotion.usageLimitPerUser) {
        const usedByUser = await WalletTransaction.countDocuments({
            userId,
            txnType: "MONTHLY_PASS",
            status: "SUCCESS",
            "rawReturn.promotionId": String(promotion._id)
        });
        if (usedByUser >= Number(promotion.usageLimitPerUser)) {
            throw new Error("B\u1ea1n \u0111\u00e3 d\u00f9ng h\u1ebft l\u01b0\u1ee3t c\u1ee7a m\u00e3 gi\u1ea3m gi\u00e1 n\u00e0y.");
        }
    }

    if (
        promotion.usageLimitTotal
        && Number(promotion.usageCount || 0) >= Number(promotion.usageLimitTotal)
    ) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 \u0111\u00e3 h\u1ebft l\u01b0\u1ee3t s\u1eed d\u1ee5ng.");
    }

    const discountAmount = calcPromotionDiscount(baseForPromo, promotion);
    if (discountAmount <= 0) {
        throw new Error("M\u00e3 gi\u1ea3m gi\u00e1 kh\u00f4ng \u00e1p d\u1ee5ng cho \u0111\u01a1n h\u00e0ng hi\u1ec7n t\u1ea1i.");
    }

    return { promotion, discountAmount };
}
async function releasePromotionReservation(promotionId) {
    if (!promotionId) return;
    await Promotion.updateOne(
        { _id: promotionId, usageCount: { $gt: 0 } },
        { $inc: { usageCount: -1 } }
    );
}

async function releaseExpiredPromotionReservations(now = new Date()) {
    const cutoff = new Date(now.getTime() - (PROMO_RESERVATION_TTL_MINUTES * 60 * 1000));
    const expiredTxs = await WalletTransaction.find({
        txnType: "MONTHLY_PASS",
        status: "PENDING",
        createdAt: { $lte: cutoff },
        "rawReturn.promotionId": { $exists: true, $ne: "" },
        "rawReturn.promoReleased": false
    })
        .select("_id txnRef rawReturn.promotionId")
        .lean();

    for (const tx of expiredTxs) {
        const promotionId = String(tx?.rawReturn?.promotionId || "").trim();
        if (!promotionId) continue;

        const updated = await WalletTransaction.updateOne(
            {
                _id: tx._id,
                status: "PENDING",
                "rawReturn.promoReleased": false
            },
            {
                $set: {
                    status: "CANCELLED",
                    note: `Payment session expired after ${PROMO_RESERVATION_TTL_MINUTES} minutes.`,
                    "rawReturn.promoReleased": true
                }
            }
        );

        if (updated.modifiedCount > 0) {
            await releasePromotionReservation(promotionId);
        }
    }
}

function pageRedirectWithMsg(type, msg, extra = {}) {
    const q = new URLSearchParams();
    q.set(type, msg);
    Object.keys(extra).forEach((k) => {
        if (extra[k] !== undefined && extra[k] !== null && extra[k] !== "") {
            q.set(k, String(extra[k]));
        }
    });
    return `/passenger/passes/monthly?${q.toString()}`;
}

function buildBaseUrl(req) {
    return process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function toOrderCode() {
    const now = Date.now();
    const rnd = Math.floor(Math.random() * 1000);
    return Number(`${String(now).slice(-9)}${String(rnd).padStart(3, "0")}`);
}

function sortObject(obj) {
    const sorted = {};
    Object.keys(obj)
        .sort()
        .forEach((key) => {
            sorted[key] = obj[key];
        });
    return sorted;
}

function vnpEncode(value) {
    return encodeURIComponent(value)
        .replace(/%20/g, "+")
        .replace(/!/g, "%21")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/'/g, "%27");
}

function signVnpParams(params, secret) {
    const sorted = sortObject(params);
    const signData = querystring.stringify(sorted, "&", "=", {
        encodeURIComponent: vnpEncode
    });
    return crypto.createHmac("sha512", secret).update(signData, "utf-8").digest("hex");
}

function buildVnpUrl(baseUrl, params, secret) {
    const sorted = sortObject(params);
    const secureHash = signVnpParams(sorted, secret);
    const query = querystring.stringify(sorted, "&", "=", {
        encodeURIComponent: vnpEncode
    });
    return `${baseUrl}?${query}&vnp_SecureHash=${secureHash}`;
}

function verifyVnpChecksum(queryObj, hashSecret) {
    const cloned = { ...queryObj };
    const secureHash = cloned.vnp_SecureHash;
    delete cloned.vnp_SecureHash;
    delete cloned.vnp_SecureHashType;
    const calc = signVnpParams(cloned, hashSecret);
    return String(calc).toLowerCase() === String(secureHash || "").toLowerCase();
}

function formatDateVnp(date = new Date()) {
    const vn = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const yyyy = vn.getFullYear();
    const MM = String(vn.getMonth() + 1).padStart(2, "0");
    const dd = String(vn.getDate()).padStart(2, "0");
    const HH = String(vn.getHours()).padStart(2, "0");
    const mm = String(vn.getMinutes()).padStart(2, "0");
    const ss = String(vn.getSeconds()).padStart(2, "0");
    return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
}

function addMinutesVnp(date = new Date(), minutes = 15) {
    const d = new Date(date.getTime() + minutes * 60 * 1000);
    return formatDateVnp(d);
}

function getClientIp(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        req.ip ||
        "127.0.0.1"
    );
}

function getVnpayBaseConfig(req) {
    const tmnCode = process.env.VNPAY_TMN_CODE || "";
    const hashSecret = process.env.VNPAY_HASH_SECRET || "";
    const vnpUrl = process.env.VNPAY_URL || "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";
    const returnUrl = process.env.VNPAY_MONTHLY_RETURN_URL
        || `${buildBaseUrl(req)}/passenger/passes/monthly/vnpay-return`;
    return { tmnCode, hashSecret, vnpUrl, returnUrl };
}

function signMomoRaw(rawSignature, accessKey, secretKey) {
    return crypto
        .createHmac("sha256", secretKey)
        .update(rawSignature)
        .digest("hex");
}

async function createMomoPayment(payload) {
    const endpoint = process.env.MOMO_ENDPOINT || "https://test-payment.momo.vn/v2/gateway/api/create";
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!res.ok || Number(json?.resultCode) !== 0 || !json?.payUrl) {
        throw new Error(`Create MoMo link failed: ${JSON.stringify(json)}`);
    }
    return json;
}

async function createMonthlyPassAfterPaid(tx) {
    const meta = tx?.rawReturn || {};
    const userId = tx.userId;
    const passType = parsePassType(meta.passType);
    const routeId = String(meta.routeId || "").trim();
    const month = parsePositiveInt(meta.month);
    const year = parsePositiveInt(meta.year);

    if (!month || !year) {
        throw new Error("Missing pass period in transaction metadata.");
    }

    let route = null;
    if (passType === PASS_TYPE.SINGLE_ROUTE) {
        route = await Route.findById(routeId).lean();
        if (!route || route.status !== "ACTIVE") {
            throw new Error("Route invalid or inactive.");
        }
    }

    const duplicateFilter = {
        userId,
        month,
        year,
        passType,
        status: { $ne: "CANCELLED" }
    };
    if (passType === PASS_TYPE.SINGLE_ROUTE) {
        duplicateFilter.routeId = routeId;
    }

    const existingPass = await MonthlyPass.findOne(duplicateFilter).lean();
    if (existingPass) {
        return existingPass;
    }

    const paidAmount = Number(tx?.amount || 0);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
        throw new Error("Invalid paid amount.");
    }

    const { validFrom, validTo } = getMonthDateRange(year, month);
    return MonthlyPass.create({
        userId,
        passType,
        routeId: passType === PASS_TYPE.SINGLE_ROUTE ? routeId : null,
        routeSnapshot: {
            routeNumber: passType === PASS_TYPE.SINGLE_ROUTE ? (route.routeNumber || "") : "LT",
            name: passType === PASS_TYPE.SINGLE_ROUTE ? (route.name || "") : "Ve lien tuyen"
        },
        passCode: makePassCode(year, month, userId, passType),
        month,
        year,
        validFrom,
        validTo,
        pricePaid: paidAmount,
        paidBy: tx?.method === PAYMENT_METHOD.MOMO ? "MOMO" : "VNPAY",
        status: "ACTIVE"
    });
}

async function getUserPasses(userId, limit = 50) {
    let myPasses = await MonthlyPass.find({ userId })
        .populate("routeId")
        .sort({ year: -1, month: -1, createdAt: -1 })
        .limit(limit)
        .lean();

    myPasses = await Promise.all(myPasses.map(async (pass) => {
        const displayRouteNumber =
            pass.routeId?.routeNumber ||
            pass.routeSnapshot?.routeNumber ||
            "";

        const displayRouteName =
            pass.routeId?.name ||
            pass.routeSnapshot?.name ||
            "Tuyen khong xac dinh";

        const displayPassType =
            pass.passType === PASS_TYPE.INTER_ROUTE ? "LIEN_TUYEN" : "DON_TUYEN";

        const mappedPass = {
            ...pass,
            displayRouteNumber,
            displayRouteName,
            displayPassType
        };

        return {
            ...mappedPass,
            qrCodeDataUrl: await generatePassQrDataUrl(mappedPass)
        };
    }));

    return myPasses;
}

exports.getMyTicketQrImage = async (req, res) => {
    try {
        if (!isPassenger(req)) {
            return res.status(401).send("Unauthorized");
        }

        const passId = String(req.params.passId || "").trim();
        if (!mongoose.Types.ObjectId.isValid(passId)) {
            return res.status(400).send("Invalid pass id");
        }

        const pass = await MonthlyPass.findOne({
            _id: passId,
            userId: req.session.userId
        })
            .populate("routeId")
            .lean();

        if (!pass) {
            return res.status(404).send("Pass not found");
        }

        const displayRouteNumber =
            pass.routeId?.routeNumber ||
            pass.routeSnapshot?.routeNumber ||
            "";

        const displayRouteName =
            pass.routeId?.name ||
            pass.routeSnapshot?.name ||
            "Tuyen khong xac dinh";

        const displayPassType =
            pass.passType === PASS_TYPE.INTER_ROUTE ? "LIEN_TUYEN" : "DON_TUYEN";

        const qrDataUrl = await generatePassQrDataUrl({
            ...pass,
            displayRouteNumber,
            displayRouteName,
            displayPassType
        });

        if (!qrDataUrl.startsWith("data:image/png;base64,")) {
            return res.status(500).send("QR generation failed");
        }

        const base64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
        const imgBuffer = Buffer.from(base64, "base64");

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "private, max-age=300");
        return res.send(imgBuffer);
    } catch (err) {
        console.error("getMyTicketQrImage:", err);
        return res.status(500).send("QR generation failed");
    }
};

exports.getMonthlyPassPage = async (req, res) => {
    try {
        if (!isPassenger(req)) return res.redirect("/login");

        await MonthlyPass.updateMany(
            { status: "ACTIVE", validTo: { $lt: new Date() } },
            { $set: { status: "EXPIRED" } }
        );

        const user = await User.findById(req.session.userId).lean();
        if (!user) return res.redirect("/login");
        const discountRate = user.isPriorityGroup ? PRIORITY_DISCOUNT_RATE : 0;

        const routes = await Route.find({ status: "ACTIVE" })
            .sort({ routeNumber: 1, name: 1 })
            .lean();

        const myPasses = await getUserPasses(user._id, 20);
        const { matrix: fareMatrix } = await getFareMatrix();
        const uiRoutes = routes.map((r) => ({
            ...r,
            effectiveMonthlyPassPrice: resolveMonthlyPassBasePrice(
                PASS_TYPE.SINGLE_ROUTE,
                Number(r.monthlyPassPrice || 0),
                fareMatrix
            )
        }));

        const now = new Date();
        const selectedMonth = parsePositiveInt(req.query.month) || (now.getMonth() + 1);
        const selectedYear = parsePositiveInt(req.query.year) || now.getFullYear();
        const priorityDiscount = await getPriorityDiscountInfo(user._id, fareMatrix);

        return res.render("passenger/monthly-pass", {
            title: "Mua vé tháng - BusDN",
            user,
            routes: uiRoutes,
            myPasses,
            success: req.query.success ? fixMojibakeVi(req.query.success) : null,
            error: req.query.error ? fixMojibakeVi(req.query.error) : null,
            selectedRouteId: req.query.routeId || "",
            selectedPassType: parsePassType(req.query.passType),
            selectedPaymentMethod: parsePaymentMethod(req.query.paymentMethod),
            selectedPromoCode: normalizePromoCode(req.query.promoCode),
            selectedMonth,
            selectedYear,
            interRouteMonthlyPrice: resolveMonthlyPassBasePrice(PASS_TYPE.INTER_ROUTE, 0, fareMatrix),
            priorityDiscountPercent: priorityDiscount.discountPercent,
            priorityDiscountEligible: priorityDiscount.eligible,
            freeRideRules: fareMatrix?.freeRideRules || null
        });
    } catch (err) {
        console.error("getMonthlyPassPage:", err);
        return res.status(500).send("Lỗi tải trang mua vé tháng.");
    }
};

exports.getMyTicketsPage = async (req, res) => {
    try {
        if (!isPassenger(req)) return res.redirect("/login");

        await MonthlyPass.updateMany(
            { status: "ACTIVE", validTo: { $lt: new Date() } },
            { $set: { status: "EXPIRED" } }
        );

        const user = await User.findById(req.session.userId).lean();
        if (!user) return res.redirect("/login");

        const myPasses = await getUserPasses(user._id, 100);

        return res.render("passenger/my-tickets", {
            title: "Ve cua toi - BusDN",
            user,
            myPasses,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error("getMyTicketsPage:", err);
        return res.status(500).send("Loi tai trang ve cua toi.");
    }
};

exports.previewPromotion = async (req, res) => {
    try {
        if (!isPassenger(req)) {
            return res.status(401).json({ ok: false, message: "Unauthorized" });
        }

        const userId = req.session.userId;
        const passType = parsePassType(req.query.passType);
        const routeId = String(req.query.routeId || "").trim();
        const promoCode = normalizePromoCode(req.query.promoCode);
        const { matrix: fareMatrix } = await getFareMatrix();

        let route = null;
        if (passType === PASS_TYPE.SINGLE_ROUTE) {
            if (!routeId) {
                return res.status(400).json({ ok: false, message: "V\u00f9i l\u00f2ng ch\u1ecdn tuy\u1ebfn tr\u01b0\u1edbc khi \u00e1p m\u00e3." });
            }
            route = await Route.findById(routeId).lean();
            if (!route || route.status !== "ACTIVE") {
                return res.status(400).json({ ok: false, message: "Tuy\u1ebfn kh\u00f4ng h\u1ee3p l\u1ec7 ho\u1eb7c \u0111\u00e3 ng\u1eebng ho\u1ea1t \u0111\u1ed9ng." });
            }
        }

        const basePrice = resolveMonthlyPassBasePrice(
            passType,
            Number(route?.monthlyPassPrice || 0),
            fareMatrix
        );
        if (!Number.isFinite(basePrice) || basePrice <= 0) {
            return res.status(400).json({ ok: false, message: "Gi\u00e1 v\u00e9 th\u00e1ng ch\u01b0a \u0111\u01b0\u1ee3c c\u1ea5u h\u00ecnh." });
        }

        const priorityDiscount = await getPriorityDiscountInfo(userId, fareMatrix);
        const discountPercent = priorityDiscount.discountPercent;
        const priceAfterPriority = applyPriorityDiscount(basePrice, discountPercent);

        if (!promoCode) {
            return res.json({
                ok: true,
                applied: false,
                message: "Ch\u01b0a nh\u1eadp m\u00e3 gi\u1ea3m gi\u00e1.",
                basePrice,
                discountPercent,
                priceAfterPriority,
                promoDiscountAmount: 0,
                finalPrice: priceAfterPriority
            });
        }

        const now = new Date();
        await releaseExpiredPromotionReservations(now);
        const { promotion, discountAmount } = await validatePromotionWithoutReserve({
            promoCode,
            userId,
            passType,
            routeId,
            baseForPromo: priceAfterPriority,
            now
        });
        const finalPrice = Math.max(1, priceAfterPriority - discountAmount);

        return res.json({
            ok: true,
            applied: true,
            message: `\u00c1p m\u00e3 ${promotion.code} th\u00e0nh c\u00f4ng, gi\u1ea3m ${discountAmount.toLocaleString("vi-VN")} \u0111.`,
            promoCode: promotion.code,
            basePrice,
            discountPercent,
            priceAfterPriority,
            promoDiscountAmount: discountAmount,
            finalPrice
        });
    } catch (err) {
        return res.status(400).json({
            ok: false,
            message: err?.message || "Kh\u00f4ng th\u1ec3 ki\u1ec3m tra m\u00e3 gi\u1ea3m gi\u00e1."
        });
    }
};
exports.purchaseMonthlyPass = async (req, res) => {
    try {
        if (!isPassenger(req)) return res.redirect("/login");

        const userId = req.session.userId;

        await applyPriorityExpiryForUser(userId);

        const passType = parsePassType(req.body.passType);
        const paymentMethod = parsePaymentMethod(req.body.paymentMethod);
        const routeId = String(req.body.routeId || "").trim();
        const promoCode = normalizePromoCode(req.body.promoCode);

        const { matrix: fareMatrix } = await getFareMatrix();

        let month = parsePositiveInt(req.body.month);
        let year = parsePositiveInt(req.body.year);

        if (!month || !year) {
            const parsed = parseMonthInput(String(req.body.passMonth || ""));
            if (parsed) {
                month = parsed.month;
                year = parsed.year;
            }
        }

        const backQuery = { passType, paymentMethod, routeId, month, year, promoCode };

        // ✅ validate input
        if (passType === PASS_TYPE.SINGLE_ROUTE && !routeId) {
            return res.redirect(pageRedirectWithMsg("error", "Vui long chon tuyen.", backQuery));
        }

        if (!month || month < 1 || month > 12) {
            return res.redirect(pageRedirectWithMsg("error", "Thang khong hop le.", backQuery));
        }

        if (!year || year < 2000) {
            return res.redirect(pageRedirectWithMsg("error", "Nam khong hop le.", backQuery));
        }

        const now = new Date();
        await releaseExpiredPromotionReservations(now);

        const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetMonth = new Date(year, month - 1, 1);

        if (targetMonth < currentMonth) {
            return res.redirect(pageRedirectWithMsg("error", "Khong the mua ve thang da qua.", backQuery));
        }

        // ✅ route
        let route = null;
        if (passType === PASS_TYPE.SINGLE_ROUTE) {
            route = await Route.findById(routeId).lean();
            if (!route || route.status !== "ACTIVE") {
                return res.redirect(pageRedirectWithMsg("error", "Tuyen khong hop le.", backQuery));
            }
        }

        // ✅ check duplicate
        const duplicate = await MonthlyPass.findOne({
            userId,
            month,
            year,
            passType,
            routeId: passType === PASS_TYPE.SINGLE_ROUTE ? routeId : undefined,
            status: { $ne: "CANCELLED" }
        });

        if (duplicate) {
            return res.redirect(pageRedirectWithMsg("error", "Ban da mua ve roi.", backQuery));
        }

        // ================= PRICE =================
        const basePrice = resolveMonthlyPassBasePrice(
            passType,
            Number(route?.monthlyPassPrice || 0),
            fareMatrix
        );

        if (!basePrice || basePrice <= 0) {
            return res.redirect(pageRedirectWithMsg("error", "Gia ve chua cau hinh.", backQuery));
        }

        const priority = await getPriorityDiscountInfo(userId, fareMatrix);
        const priceAfterPriority = applyPriorityDiscount(basePrice, priority.discountPercent);

        let promoReserved = null;
        let promoDiscount = 0;

        if (promoCode) {
            const result = await validateAndReservePromotion({
                promoCode,
                userId,
                passType,
                routeId,
                baseForPromo: priceAfterPriority,
                now
            });

            promoReserved = result.promotion;
            promoDiscount = result.discountAmount;
        }

        const finalPrice = Math.max(1, priceAfterPriority - promoDiscount);

        // ================= TRANSACTION =================
        const orderCode = toOrderCode();
        const txnRef = `${paymentMethod}-MP-${orderCode}`;

        const tx = await WalletTransaction.create({
            userId,
            amount: finalPrice,
            originalAmount: basePrice,
            discountAmount: basePrice - finalPrice,
            direction: "OUT",
            txnType: "MONTHLY_PASS",
            method: paymentMethod,
            status: "PENDING",
            txnRef,
            rawReturn: {
                orderCode,
                passType,
                routeId,
                month,
                year,
                promoCode: promoReserved?.code || "",
                promotionId: promoReserved?._id || "",
                promoDiscount,
                promoReleased: false
            }
        });

        // ================= VNPAY =================
        if (paymentMethod === PAYMENT_METHOD.VNPAY) {
            const { tmnCode, hashSecret, vnpUrl, returnUrl } = getVnpayBaseConfig(req);

            const vnpParams = {
                vnp_TxnRef: txnRef,
                vnp_Amount: finalPrice * 100,
                vnp_ReturnUrl: returnUrl
            };

            const url = buildVnpUrl(vnpUrl, vnpParams, hashSecret);
            return res.redirect(url);
        }

        // ================= MOMO =================
        if (paymentMethod === PAYMENT_METHOD.MOMO) {
            const momo = await createMomoPayment({
                amount: finalPrice,
                orderId: txnRef
            });

            return res.redirect(momo.payUrl);
        }

        return res.redirect(pageRedirectWithMsg("error", "Payment method khong hop le.", backQuery));

    } catch (err) {
        console.error("purchaseMonthlyPass:", err);
        return res.redirect(pageRedirectWithMsg("error", "Co loi xay ra."));
    }
};

exports.vnpayReturnMonthlyPass = async (req, res) => {
    try {
        const query = { ...req.query };
        const { hashSecret } = getVnpayBaseConfig(req);
        if (!hashSecret) {
            return res.redirect(pageRedirectWithMsg("error", "Thieu cau hinh VNPAY hash secret."));
        }
        if (!query.vnp_TxnRef) {
            return res.redirect(pageRedirectWithMsg("error", "Thieu thong tin giao dich VNPAY."));
        }
        if (!verifyVnpChecksum(query, hashSecret)) {
            return res.redirect(pageRedirectWithMsg("error", "Chu ky VNPAY khong hop le."));
        }

        const tx = await WalletTransaction.findOne({ txnRef: query.vnp_TxnRef });
        if (!tx) {
            return res.redirect(pageRedirectWithMsg("error", "Khong tim thay giao dich VNPAY."));
        }
        if (tx.status === "SUCCESS") {
            return res.redirect(pageRedirectWithMsg("success", "Giao dich da duoc xac nhan thanh cong."));
        }

        const vnpAmount = Number(query.vnp_Amount || 0) / 100;
        if (!vnpAmount || Number(tx.amount) !== vnpAmount) {
            await WalletTransaction.updateOne(
                { _id: tx._id, status: "PENDING" },
                { $set: { status: "FAILED", note: "Invalid VNPAY amount." } }
            );
            return res.redirect(pageRedirectWithMsg("error", "Sai lech so tien giao dich."));
        }

        const isSuccess = query.vnp_ResponseCode === "00"
            && (!query.vnp_TransactionStatus || query.vnp_TransactionStatus === "00");

        if (!isSuccess) {
            const nextStatus = query.vnp_ResponseCode === "24" ? "CANCELLED" : "FAILED";
            await WalletTransaction.updateOne(
                { _id: tx._id, status: "PENDING" },
                { $set: { status: nextStatus, note: `VNPAY failed (${query.vnp_ResponseCode || "N/A"})`, rawIpn: query } }
            );
            const promoId = tx?.rawReturn?.promotionId ? String(tx.rawReturn.promotionId) : "";
            if (promoId && !tx?.rawReturn?.promoReleased) {
                await releasePromotionReservation(promoId);
                await WalletTransaction.updateOne({ _id: tx._id }, { $set: { "rawReturn.promoReleased": true } });
            }
            return res.redirect(pageRedirectWithMsg("error", "Thanh toan VNPAY that bai hoac bi huy."));
        }

        const pass = await createMonthlyPassAfterPaid(tx);
        await WalletTransaction.updateOne(
            { _id: tx._id },
            {
                $set: {
                    status: "SUCCESS",
                    method: "VNPAY",
                    relatedMonthlyPassId: pass?._id || null,
                    paidAt: new Date(),
                    note: `VNPAY paid txnRef ${tx.txnRef}`,
                    rawIpn: query
                }
            }
        );

        return res.redirect(pageRedirectWithMsg("success", "Thanh toan VNPAY thanh cong. Ve thang da duoc kich hoat."));
    } catch (err) {
        console.error("vnpayReturnMonthlyPass:", err);
        return res.redirect(pageRedirectWithMsg("error", "Loi xu ly ket qua thanh toan VNPAY."));
    }
};

exports.momoReturnMonthlyPass = async (req, res) => {
    try {
        const orderId = String(req.query.orderId || req.body?.orderId || "").trim();
        const resultCode = String(req.query.resultCode || req.body?.resultCode || "");
        if (!orderId) {
            return res.redirect(pageRedirectWithMsg("error", "Phien thanh toan MoMo khong hop le."));
        }

        const tx = await WalletTransaction.findOne({ txnRef: orderId });
        if (!tx) {
            return res.redirect(pageRedirectWithMsg("error", "Khong tim thay giao dich MoMo."));
        }
        if (tx.status === "SUCCESS") {
            return res.redirect(pageRedirectWithMsg("success", "Giao dich da duoc xac nhan thanh cong."));
        }

        if (resultCode !== "0") {
            const nextStatus = resultCode === "1006" ? "CANCELLED" : "FAILED";
            await WalletTransaction.updateOne(
                { _id: tx._id, status: "PENDING" },
                { $set: { status: nextStatus, note: `MoMo failed (${resultCode || "N/A"})`, rawIpn: req.query } }
            );
            const promoId = tx?.rawReturn?.promotionId ? String(tx.rawReturn.promotionId) : "";
            if (promoId && !tx?.rawReturn?.promoReleased) {
                await releasePromotionReservation(promoId);
                await WalletTransaction.updateOne({ _id: tx._id }, { $set: { "rawReturn.promoReleased": true } });
            }
            return res.redirect(pageRedirectWithMsg("error", "Thanh toan MoMo that bai hoac bi huy."));
        }

        const pass = await createMonthlyPassAfterPaid(tx);
        await WalletTransaction.updateOne(
            { _id: tx._id },
            {
                $set: {
                    status: "SUCCESS",
                    method: "MOMO",
                    relatedMonthlyPassId: pass?._id || null,
                    paidAt: new Date(),
                    note: `MoMo paid orderId ${orderId}`,
                    rawIpn: req.query
                }
            }
        );

        return res.redirect(pageRedirectWithMsg("success", "Thanh toan MoMo thanh cong. Ve thang da duoc kich hoat."));
    } catch (err) {
        console.error("momoReturnMonthlyPass:", err);
        return res.redirect(pageRedirectWithMsg("error", "Loi xu ly ket qua thanh toan MoMo."));
    }
};
