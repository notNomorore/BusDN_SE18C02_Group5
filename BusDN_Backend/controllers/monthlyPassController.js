const { User, Route, MonthlyPass, WalletTransaction } = require("../models");

function isPassenger(req) {
    return req.session?.userId && req.session?.role === "PASSENGER";
}

function parsePositiveInt(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// legacy support: YYYY-MM
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

function getDefaultMonthValue() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function makePassCode(year, month, userId) {
    const mm = String(month).padStart(2, "0");
    const shortUser = String(userId).slice(-6).toUpperCase();
    const rand = Math.floor(Math.random() * 9000 + 1000);
    return `MP-${year}${mm}-${shortUser}-${rand}`;
}

function pad2(n) {
    return String(n).padStart(2, "0");
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

// GET /passenger/passes/monthly
exports.getMonthlyPassPage = async (req, res) => {
    try {
        if (!isPassenger(req)) return res.redirect("/login");

        // cập nhật vé hết hạn
        await MonthlyPass.updateMany(
            { status: "ACTIVE", validTo: { $lt: new Date() } },
            { $set: { status: "EXPIRED" } }
        );

        const user = await User.findById(req.session.userId).lean();
        if (!user) return res.redirect("/login");

        const routes = await Route.find({ status: "ACTIVE" })
            .sort({ routeNumber: 1, name: 1 })
            .lean();

        let myPasses = await MonthlyPass.find({ userId: user._id })
            .populate("routeId")
            .sort({ year: -1, month: -1, createdAt: -1 })
            .limit(20)
            .lean();

        myPasses = myPasses.map((pass) => {
            const displayRouteNumber =
                pass.routeId?.routeNumber ||
                pass.routeSnapshot?.routeNumber ||
                "";

            const displayRouteName =
                pass.routeId?.name ||
                pass.routeSnapshot?.name ||
                "Tuyến không xác định";

            return {
                ...pass,
                displayRouteNumber,
                displayRouteName
            };
        });

        const now = new Date();
        const selectedMonth = parsePositiveInt(req.query.month) || (now.getMonth() + 1);
        const selectedYear = parsePositiveInt(req.query.year) || now.getFullYear();

        return res.render("passenger/monthly-pass", {
            title: "Mua vé tháng - BusDN",
            user,
            walletBalance: Number(user.walletBalance || 0),
            routes,
            myPasses,
            success: req.query.success || null,
            error: req.query.error || null,
            selectedRouteId: req.query.routeId || "",
            selectedMonth,
            selectedYear,
            defaultPassMonth: getDefaultMonthValue()
        });
    } catch (err) {
        console.error("❌ getMonthlyPassPage:", err);
        return res.status(500).send("Lỗi tải trang mua vé tháng.");
    }
};

// POST /passenger/passes/monthly/purchase
exports.purchaseMonthlyPass = async (req, res) => {
    try {
        if (!isPassenger(req)) return res.redirect("/login");

        console.log("🧾 purchaseMonthlyPass body =", req.body);

        const userId = req.session.userId;
        const routeId = String(req.body.routeId || "").trim();

        let month = parsePositiveInt(req.body.month);
        let year = parsePositiveInt(req.body.year);

        if (!month || !year) {
            const legacyParsed = parseMonthInput(String(req.body.passMonth || "").trim());
            if (legacyParsed) {
                month = legacyParsed.month;
                year = legacyParsed.year;
            }
        }

        const backQuery = {
            routeId,
            month: month || "",
            year: year || ""
        };

        if (!routeId) {
            return res.redirect(pageRedirectWithMsg("error", "Vui lòng chọn tuyến.", backQuery));
        }

        if (!month || month < 1 || month > 12) {
            return res.redirect(pageRedirectWithMsg("error", "Tháng áp dụng không hợp lệ.", backQuery));
        }

        if (!year || year < 2000 || year > 3000) {
            return res.redirect(pageRedirectWithMsg("error", "Năm áp dụng không hợp lệ.", backQuery));
        }

        // Không cho mua tháng quá khứ
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const targetMonthStart = new Date(year, month - 1, 1);

        if (targetMonthStart < currentMonthStart) {
            return res.redirect(pageRedirectWithMsg("error", "Không thể mua vé cho tháng đã qua.", backQuery));
        }

        const route = await Route.findById(routeId).lean();
        if (!route || route.status !== "ACTIVE") {
            return res.redirect(
                pageRedirectWithMsg("error", "Tuyến không hợp lệ hoặc đã ngưng hoạt động.", backQuery)
            );
        }

        // ✅ Kiểm tra trùng theo TUYẾN, không còn kiểm tra theo THÁNG/NĂM nữa
const existingPass = await MonthlyPass.findOne({
    userId,
    routeId,
    month,
    year,
    status: { $ne: "CANCELLED" }
}).lean();

if (existingPass) {
    return res.redirect(
        pageRedirectWithMsg(
            "error",
            `Bạn đã mua vé tháng cho tuyến này trong ${pad2(month)}/${year} rồi.`,
            backQuery
        )
    );
}

        const price = Number(route.monthlyPassPrice || 0);
        if (!Number.isFinite(price) || price <= 0) {
            return res.redirect(
                pageRedirectWithMsg("error", "Giá vé tháng tuyến này chưa được cấu hình.", backQuery)
            );
        }

        // Trừ ví atomically
        const userAfterDeduct = await User.findOneAndUpdate(
            { _id: userId, walletBalance: { $gte: price } },
            { $inc: { walletBalance: -price } },
            { new: true }
        );

        if (!userAfterDeduct) {
            return res.redirect(
                pageRedirectWithMsg("error", "Số dư ví không đủ để mua vé tháng.", backQuery)
            );
        }

        const { validFrom, validTo } = getMonthDateRange(year, month);

        let createdPass = null;

        try {
            createdPass = await MonthlyPass.create({
                userId,
                routeId,
                routeSnapshot: {
                    routeNumber: route.routeNumber || "",
                    name: route.name || ""
                },
                passCode: makePassCode(year, month, userId),
                month,
                year,
                validFrom,
                validTo,
                pricePaid: price,
                paidBy: "WALLET",
                status: "ACTIVE"
            });
        } catch (createErr) {
            // rollback tiền nếu tạo vé lỗi
            await User.findByIdAndUpdate(userId, { $inc: { walletBalance: price } });

if (createErr?.code === 11000) {
    return res.redirect(
        pageRedirectWithMsg(
            "error",
            `Bạn đã mua vé tháng cho tuyến này trong ${pad2(month)}/${year} rồi. Giao dịch trước đó có thể đã được xử lý.`,
            backQuery
        )
    );
}

            throw createErr;
        }

        await WalletTransaction.create({
            userId,
            amount: price,
            direction: "OUT",
            txnType: "MONTHLY_PASS",
            note: `Mua vé tháng tuyến ${route.routeNumber || ""} - ${route.name || ""} (${pad2(month)}/${year})`,
            method: "WALLET",
            status: "SUCCESS",
            relatedMonthlyPassId: createdPass._id,
            paidAt: new Date()
        });

        return res.redirect(
            pageRedirectWithMsg(
                "success",
                `Mua vé tháng thành công cho tuyến ${route.routeNumber} - ${route.name} (${pad2(month)}/${year}).`,
                { routeId, month, year }
            )
        );
    } catch (err) {
        console.error("❌ purchaseMonthlyPass:", err);
        return res.redirect(
            "/passenger/passes/monthly?error=" +
            encodeURIComponent("Lỗi hệ thống khi mua vé tháng.")
        );
    }
};