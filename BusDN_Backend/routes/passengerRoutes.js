const express = require("express");
const router = express.Router();

const walletController = require("../controllers/walletController");
const monthlyPassController = require("../controllers/monthlyPassController");

function requirePassenger(req, res, next) {
    if (!req.session?.userId) return res.redirect("/login");
    if (req.session?.role !== "PASSENGER") return res.redirect("/profile");
    next();
}

/* =========================
   UC14 - View Wallet Balance
========================= */
router.get("/wallet", requirePassenger, walletController.getWalletPage);
router.get("/wallet/balance", requirePassenger, walletController.getWalletBalance);

/* =========================
   UC13 - Deposit Wallet (VNPAY)
========================= */
router.get("/wallet/deposit", requirePassenger, walletController.getDepositPage);
router.post("/wallet/deposit", requirePassenger, walletController.postDeposit);

// Return URL (trình duyệt redirect về)
router.get("/wallet/vnpay-return", walletController.vnpayReturn);

// IPN URL (VNPAY gọi server-server, không cần login)
router.get("/wallet/vnpay-ipn", walletController.vnpayIpn);

/* =========================
   UC15 - Purchase Monthly Pass
========================= */
// URL gốc
router.get("/passes/monthly", requirePassenger, monthlyPassController.getMonthlyPassPage);

// ✅ Alias để menu "Vé của tôi" dùng URL đẹp
router.get("/monthly-pass", requirePassenger, monthlyPassController.getMonthlyPassPage);

// Mua vé tháng
router.post("/passes/monthly/purchase", requirePassenger, monthlyPassController.purchaseMonthlyPass);

module.exports = router;