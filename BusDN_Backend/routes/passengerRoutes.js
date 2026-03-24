const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const monthlyPassController = require("../controllers/monthlyPassController");

function requirePassenger(req, res, next) {
    const authHeader = String(req.headers.authorization || "").trim();
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const bodyToken = String(req.body?.authToken || "").trim();
    const queryToken = String(req.query?.authToken || "").trim();
    const token = bearerToken || bodyToken || queryToken;

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret_key");
            if (decoded?.role !== "PASSENGER") {
                return res.redirect("/profile");
            }

            req.session = {
                ...(req.session || {}),
                userId: decoded.userId,
                role: decoded.role
            };
            return next();
        } catch (error) {
            return res.redirect("/login");
        }
    }

    if (req.session?.userId && req.session?.role === "PASSENGER") {
        return next();
    }

    if (req.session?.userId) return res.redirect("/profile");
    return res.redirect("/login");
}

/* Monthly pass purchase */
router.get("/passes/monthly", requirePassenger, monthlyPassController.getMonthlyPassPage);
router.get("/passes/monthly/promo-preview", requirePassenger, monthlyPassController.previewPromotion);
router.get("/passes/monthly/checkout", requirePassenger, (req, res) => {
    req.body = { ...req.query };
    return monthlyPassController.purchaseMonthlyPass(req, res);
});
router.post("/passes/monthly/purchase", requirePassenger, monthlyPassController.purchaseMonthlyPass);
router.get("/passes/monthly/vnpay-return", monthlyPassController.vnpayReturnMonthlyPass);
router.get("/passes/monthly/momo-return", monthlyPassController.momoReturnMonthlyPass);

/* My tickets */
router.get("/monthly-pass", requirePassenger, monthlyPassController.getMyTicketsPage);
router.get("/my-tickets", requirePassenger, monthlyPassController.getMyTicketsPage);
router.get("/my-tickets/:passId/qr.png", requirePassenger, monthlyPassController.getMyTicketQrImage);

module.exports = router;
