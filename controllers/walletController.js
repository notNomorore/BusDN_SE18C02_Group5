const crypto = require("crypto");
const querystring = require("querystring");
const { User, WalletTransaction, MonthlyPass } = require("../models");

/* =========================
   Helpers
========================= */
function sortObject(obj) {
    const sorted = {};
    Object.keys(obj)
        .sort()
        .forEach((key) => {
            sorted[key] = obj[key];
        });
    return sorted;
}

function formatDateVnp(date = new Date()) {
    // YYYYMMDDHHmmss theo giờ VN
    const vn = new Date(
        date.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
    );

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

function genTxnRef(userId) {
    const ts = Date.now();
    const rnd = Math.floor(1000 + Math.random() * 9000);
    const uid = String(userId || "").slice(-4).toUpperCase();
    return `WLT${ts}${rnd}${uid}`;
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

    return crypto
        .createHmac("sha512", secret)
        .update(signData, "utf-8")
        .digest("hex");
}

function buildVnpUrl(baseUrl, params, secret) {
    const sorted = sortObject(params);
    const secureHash = signVnpParams(sorted, secret);
    const query = querystring.stringify(sorted, "&", "=", {
        encodeURIComponent: vnpEncode
    });
    return `${baseUrl}?${query}&vnp_SecureHash=${secureHash}`;
}

function parseMoneyInput(value) {
    if (value === null || value === undefined) return 0;
    // Cho phép input kiểu "50,000" hoặc "50.000"
    const normalized = String(value).replace(/[^\d]/g, "");
    return Number(normalized || 0);
}

function walletPageRedirectWithMsg(type, msg) {
    return `/passenger/wallet?${type}=${encodeURIComponent(msg)}`;
}

function depositPageRedirectWithMsg(type, msg) {
    return `/passenger/wallet/deposit?${type}=${encodeURIComponent(msg)}`;
}

function verifyVnpChecksum(queryObj, hashSecret) {
    const cloned = { ...queryObj };
    const secureHash = cloned.vnp_SecureHash;
    delete cloned.vnp_SecureHash;
    delete cloned.vnp_SecureHashType;

    const calc = signVnpParams(cloned, hashSecret);
    return String(calc).toLowerCase() === String(secureHash || "").toLowerCase();
}

function getDefaultReturnUrl(req) {
    return (
        process.env.VNPAY_RETURN_URL ||
        `${req.protocol}://${req.get("host")}/passenger/wallet/vnpay-return`
    );
}

/* =========================
   Internal: update trạng thái giao dịch
   - chống cộng tiền 2 lần bằng filter status:PENDING
========================= */
async function applyDepositSuccessIfFirstTime(tx, vnpQuery, source = "RETURN") {
    // Chỉ update thành công nếu đang PENDING
    const updated = await WalletTransaction.findOneAndUpdate(
        { _id: tx._id, status: "PENDING" },
        {
            $set: {
                status: "SUCCESS",
                vnpTransactionNo: vnpQuery.vnp_TransactionNo || tx.vnpTransactionNo || "",
                bankCode: vnpQuery.vnp_BankCode || tx.bankCode || "",
                cardType: vnpQuery.vnp_CardType || tx.cardType || "",
                payDate: vnpQuery.vnp_PayDate || tx.payDate || "",
                responseCode: vnpQuery.vnp_ResponseCode || "",
                transactionStatus: vnpQuery.vnp_TransactionStatus || "",
                paidAt: new Date(),
                ...(source === "IPN" ? { rawIpn: vnpQuery } : { rawReturn: vnpQuery })
            }
        },
        { new: true }
    );

    if (updated) {
        // Cộng ví đúng 1 lần (chỉ khi vừa chuyển từ PENDING -> SUCCESS)
        await User.updateOne(
            { _id: tx.userId },
            { $inc: { walletBalance: Number(tx.amount || 0) } }
        );
        return { applied: true, tx: updated };
    }

    // Nếu không update được, có thể đã SUCCESS trước đó (return/ipn trùng)
    const latest = await WalletTransaction.findById(tx._id).lean();
    return { applied: false, tx: latest };
}

async function markDepositFailedIfPending(tx, vnpQuery, source = "RETURN") {
    const nextStatus =
        vnpQuery.vnp_ResponseCode === "24" ? "CANCELLED" : "FAILED";

    await WalletTransaction.updateOne(
        { _id: tx._id, status: "PENDING" },
        {
            $set: {
                status: nextStatus,
                vnpTransactionNo: vnpQuery.vnp_TransactionNo || tx.vnpTransactionNo || "",
                bankCode: vnpQuery.vnp_BankCode || tx.bankCode || "",
                cardType: vnpQuery.vnp_CardType || tx.cardType || "",
                payDate: vnpQuery.vnp_PayDate || tx.payDate || "",
                responseCode: vnpQuery.vnp_ResponseCode || "",
                transactionStatus: vnpQuery.vnp_TransactionStatus || "",
                ...(source === "IPN" ? { rawIpn: vnpQuery } : { rawReturn: vnpQuery })
            }
        }
    );
}

/* =========================
   Controller
========================= */

// UC14 - Trang ví
exports.getWalletPage = async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).lean();
        if (!user) return res.redirect("/login");

        const transactions = await WalletTransaction.find({
            userId: user._id
        })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();

        // Vé tháng gần đây (để wallet.ejs hiển thị sidebar)
        const myPasses = await MonthlyPass.find({ userId: user._id })
            .populate("routeId")
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();

        return res.render("passenger/wallet", {
            user,
            walletBalance: Number(user.walletBalance || 0),

            // truyền cả 2 tên để tương thích nhiều view
            transactions,
            walletTransactions: transactions,

            myPasses,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error("❌ getWalletPage:", err);
        return res.redirect(
            "/profile?error=" + encodeURIComponent("Không thể tải trang ví.")
        );
    }
};

// API lấy số dư ví (AJAX polling)
exports.getWalletBalance = async (req, res) => {
    try {
        const user = await User.findById(req.session.userId)
            .select("walletBalance")
            .lean();

        const amount = Number(user?.walletBalance || 0);

        return res.json({
            ok: true,
            walletBalance: amount,
            walletBalanceText: amount.toLocaleString("vi-VN")
        });
    } catch (err) {
        console.error("❌ getWalletBalance:", err);
        return res.status(500).json({
            ok: false,
            message: "Không lấy được số dư ví"
        });
    }
};

// UC13 - Trang nạp ví
exports.getDepositPage = async (req, res) => {
    try {
        const user = await User.findById(req.session.userId).lean();
        if (!user) return res.redirect("/login");

        // mệnh giá gợi ý cho UI
        const allowedAmounts = [50000, 100000, 200000, 500000, 1000000, 2000000];

        // chỉ lấy giao dịch nạp ví gần đây (trang nạp tiền)
        const walletTransactions = await WalletTransaction.find({
            userId: user._id,
            txnType: "DEPOSIT"
        })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        return res.render("passenger/deposit-wallet", {
            title: "Nạp tiền vào ví - BusDN",
            user,
            walletBalance: Number(user.walletBalance || 0),

            // để tương thích view cũ/mới
            allowedAmounts,
            walletTransactions,
            transactions: walletTransactions,

            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error("❌ getDepositPage:", err);
        return res.redirect(
            walletPageRedirectWithMsg("error", "Không thể mở trang nạp ví.")
        );
    }
};

// UC13 - Tạo yêu cầu thanh toán VNPAY
exports.postDeposit = async (req, res) => {
    try {
        const amount = parseMoneyInput(req.body.amount);
        const bankCode = (req.body.bankCode || "").trim();

        if (!Number.isFinite(amount) || amount < 10000) {
            return res.redirect(
                depositPageRedirectWithMsg("error", "Số tiền nạp tối thiểu là 10.000 đ.")
            );
        }

        if (amount > 50000000) {
            return res.redirect(
                depositPageRedirectWithMsg("error", "Số tiền nạp tối đa mỗi lần là 50.000.000 đ.")
            );
        }

        const VNPAY_TMN_CODE = process.env.VNPAY_TMN_CODE;
        const VNPAY_HASH_SECRET = process.env.VNPAY_HASH_SECRET;
        const VNPAY_URL =
            process.env.VNPAY_URL ||
            "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";

        if (!VNPAY_TMN_CODE || !VNPAY_HASH_SECRET) {
            return res.redirect(
                depositPageRedirectWithMsg("error", "Thiếu cấu hình VNPAY trong .env")
            );
        }

        const user = await User.findById(req.session.userId)
            .select("_id fullName email")
            .lean();

        if (!user) return res.redirect("/login");

        const txnRef = genTxnRef(user._id);

        // Lưu giao dịch PENDING trước khi redirect sang VNPAY
        await WalletTransaction.create({
            userId: user._id,
            txnRef,
            amount,
            direction: "IN",
            txnType: "DEPOSIT",
            note: `Nạp ví BusDN ${amount.toLocaleString("vi-VN")} đ`,
            method: "VNPAY",
            status: "PENDING"
        });

        const now = new Date();
        const createDate = formatDateVnp(now);
        const expireDate = addMinutesVnp(now, 15);

        const vnpParams = {
            vnp_Version: "2.1.0",
            vnp_Command: "pay",
            vnp_TmnCode: VNPAY_TMN_CODE,
            vnp_Locale: "vn",
            vnp_CurrCode: "VND",
            vnp_TxnRef: txnRef,
            vnp_OrderInfo: `Nap vi BusDN ${txnRef}`,
            vnp_OrderType: "other",
            vnp_Amount: amount * 100, // VNPAY yêu cầu x100
            vnp_ReturnUrl: getDefaultReturnUrl(req),
            vnp_IpAddr: getClientIp(req),
            vnp_CreateDate: createDate,
            vnp_ExpireDate: expireDate
        };

        if (bankCode) {
            vnpParams.vnp_BankCode = bankCode;
        }

        const paymentUrl = buildVnpUrl(VNPAY_URL, vnpParams, VNPAY_HASH_SECRET);
        return res.redirect(paymentUrl);
    } catch (err) {
        console.error("❌ postDeposit:", err);
        return res.redirect(
            depositPageRedirectWithMsg("error", "Không tạo được yêu cầu thanh toán.")
        );
    }
};

// Return URL (trình duyệt người dùng quay về)
exports.vnpayReturn = async (req, res) => {
    try {
        const query = { ...req.query };

        if (!query.vnp_TxnRef) {
            return res.redirect(
                walletPageRedirectWithMsg("error", "Thiếu thông tin giao dịch từ VNPAY.")
            );
        }

        const hashSecret = process.env.VNPAY_HASH_SECRET;
        if (!hashSecret) {
            return res.redirect(
                walletPageRedirectWithMsg("error", "Thiếu cấu hình VNPAY hash secret.")
            );
        }

        const isValidChecksum = verifyVnpChecksum(query, hashSecret);
        if (!isValidChecksum) {
            return res.redirect(
                walletPageRedirectWithMsg("error", "Chữ ký VNPAY không hợp lệ.")
            );
        }

        const tx = await WalletTransaction.findOne({ txnRef: query.vnp_TxnRef });
        if (!tx) {
            return res.redirect(
                walletPageRedirectWithMsg("error", "Không tìm thấy giao dịch nạp ví.")
            );
        }

        // Kiểm tra amount đối soát
        const vnpAmount = Number(query.vnp_Amount || 0) / 100;
        if (vnpAmount && Number(tx.amount) !== vnpAmount) {
            await markDepositFailedIfPending(tx, query, "RETURN");
            return res.redirect(
                walletPageRedirectWithMsg("error", "Sai lệch số tiền giao dịch.")
            );
        }

        const isSuccess =
            query.vnp_ResponseCode === "00" &&
            (!query.vnp_TransactionStatus || query.vnp_TransactionStatus === "00");

        if (isSuccess) {
            const result = await applyDepositSuccessIfFirstTime(tx, query, "RETURN");

            if (result.applied) {
                return res.redirect(
                    walletPageRedirectWithMsg("success", "Nạp tiền vào ví thành công!")
                );
            }

            // Đã xử lý trước đó (vd: IPN đến trước)
            if (result.tx?.status === "SUCCESS") {
                return res.redirect(
                    walletPageRedirectWithMsg("success", "Giao dịch đã được xác nhận thành công.")
                );
            }

            return res.redirect(
                walletPageRedirectWithMsg("error", "Giao dịch đã được xử lý ở trạng thái khác.")
            );
        }

        await markDepositFailedIfPending(tx, query, "RETURN");

        if (query.vnp_ResponseCode === "24") {
            return res.redirect(
                walletPageRedirectWithMsg("error", "Bạn đã hủy giao dịch nạp tiền.")
            );
        }

        return res.redirect(
            walletPageRedirectWithMsg(
                "error",
                `Nạp tiền thất bại (Mã lỗi: ${query.vnp_ResponseCode || "N/A"}).`
            )
        );
    } catch (err) {
        console.error("❌ vnpayReturn:", err);
        return res.redirect(
            walletPageRedirectWithMsg("error", "Lỗi xử lý kết quả thanh toán.")
        );
    }
};

// IPN URL (VNPAY gọi server-server)
exports.vnpayIpn = async (req, res) => {
    try {
        const query = { ...req.query };
        const hashSecret = process.env.VNPAY_HASH_SECRET;

        if (!hashSecret) {
            return res.status(200).json({ RspCode: "97", Message: "Invalid checksum" });
        }

        const isValidChecksum = verifyVnpChecksum(query, hashSecret);
        if (!isValidChecksum) {
            return res.status(200).json({ RspCode: "97", Message: "Invalid checksum" });
        }

        const txnRef = query.vnp_TxnRef;
        const tx = await WalletTransaction.findOne({ txnRef });

        if (!tx) {
            return res.status(200).json({ RspCode: "01", Message: "Order not found" });
        }

        // Đối soát amount
        const vnpAmount = Number(query.vnp_Amount || 0) / 100;
        if (!vnpAmount || Number(tx.amount) !== vnpAmount) {
            await markDepositFailedIfPending(tx, query, "IPN");
            return res.status(200).json({ RspCode: "04", Message: "Invalid amount" });
        }

        const isSuccess =
            query.vnp_ResponseCode === "00" &&
            (!query.vnp_TransactionStatus || query.vnp_TransactionStatus === "00");

        if (isSuccess) {
            const result = await applyDepositSuccessIfFirstTime(tx, query, "IPN");

            // applied = true: vừa cộng tiền xong
            // applied = false + tx SUCCESS: đã cộng trước đó (return xử lý trước)
            if (result.applied || result.tx?.status === "SUCCESS") {
                return res.status(200).json({ RspCode: "00", Message: "Confirm Success" });
            }

            return res.status(200).json({ RspCode: "02", Message: "Order already confirmed" });
        }

        await markDepositFailedIfPending(tx, query, "IPN");
        return res.status(200).json({ RspCode: "00", Message: "Confirm Success" });
    } catch (err) {
        console.error("❌ vnpayIpn:", err);
        return res.status(200).json({ RspCode: "99", Message: "Unknown error" });
    }
};