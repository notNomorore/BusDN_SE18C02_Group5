const express = require("express");
const router = express.Router();

const monthlyPassController = require("../controllers/monthlyPassController");

function requirePassenger(req, res, next) {
    if (!req.session?.userId) return res.redirect("/login");
    if (req.session?.role !== "PASSENGER") return res.redirect("/profile");
    next();
}

/* Monthly pass purchase */
router.get("/passes/monthly", requirePassenger, monthlyPassController.getMonthlyPassPage);
router.get("/passes/monthly/promo-preview", requirePassenger, monthlyPassController.previewPromotion);
router.post("/passes/monthly/purchase", requirePassenger, monthlyPassController.purchaseMonthlyPass);
router.get("/passes/monthly/vnpay-return", monthlyPassController.vnpayReturnMonthlyPass);
router.get("/passes/monthly/momo-return", monthlyPassController.momoReturnMonthlyPass);

/* My tickets */
router.get("/monthly-pass", requirePassenger, monthlyPassController.getMyTicketsPage);
router.get("/my-tickets", requirePassenger, monthlyPassController.getMyTicketsPage);
router.get("/my-tickets/:passId/qr.png", requirePassenger, monthlyPassController.getMyTicketQrImage);

module.exports = router;
