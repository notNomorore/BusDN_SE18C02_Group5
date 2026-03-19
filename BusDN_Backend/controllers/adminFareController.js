const { Route } = require("../models");
const { renderAdmin } = require("../middleware/renderAdmin");
const {
    getFareMatrix,
    upsertFareMatrix,
    resolveMonthlyPassBasePrice,
    estimateSingleRideFare
} = require("../services/fareMatrixService");

function clean(v) {
    return typeof v === "string" ? v.trim() : "";
}

function toNumberOrNull(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n;
}

function setFlash(req, key, value) {
    if (req.session) req.session[key] = value;
}

function getFlash(req, key) {
    const value = req.session?.[key] || null;
    if (req.session) delete req.session[key];
    return value;
}

function parseTiers(text) {
    const lines = String(text || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

    const rows = [];
    for (const line of lines) {
        const parts = line.split(":").map((s) => s.trim());
        if (parts.length !== 2) {
            throw new Error("Sai dinh dang bac gia ve luot. Dung mau: max_km:gia.");
        }
        const maxStr = parts[0].toUpperCase();
        const price = Number(parts[1]);
        if (!Number.isFinite(price) || price < 0) {
            throw new Error("Gia trong bac ve luot phai la so >= 0.");
        }
        const maxDistanceKm = maxStr === "INF" ? null : Number(parts[0]);
        if (maxStr !== "INF" && (!Number.isFinite(maxDistanceKm) || maxDistanceKm <= 0)) {
            throw new Error("Canh tren cua bac gia phai > 0 hoac INF.");
        }
        rows.push({ maxDistanceKm, price });
    }
    if (!rows.length) {
        throw new Error("Phai co it nhat 1 bac gia cho ve luot.");
    }
    return rows;
}

function tiersToText(tiers = []) {
    return tiers
        .map((row) => `${row.maxDistanceKm === null ? "INF" : row.maxDistanceKm}:${row.price}`)
        .join("\n");
}

exports.getFaresPage = async (req, res) => {
    try {
        const [{ matrix, source }, routes] = await Promise.all([
            getFareMatrix(),
            Route.find({ status: "ACTIVE" }).sort({ routeNumber: 1 }).lean()
        ]);

        const routeFarePreview = routes.map((route) => ({
            _id: route._id,
            routeNumber: route.routeNumber,
            name: route.name,
            routeMonthlyPassPrice: Number(route.monthlyPassPrice || 0),
            effectiveMonthlyPrice: resolveMonthlyPassBasePrice(
                "SINGLE_ROUTE",
                Number(route.monthlyPassPrice || 0),
                matrix
            ),
            singleRideEstimatedFare: estimateSingleRideFare(Number(route.distance || 0), matrix)
        }));

        return renderAdmin(req, res, "admin/fares", "Cau hinh bang gia ve", {
            path: "fares",
            matrix,
            matrixSource: source,
            tiersText: tiersToText(matrix.singleRide.distanceTiers),
            success: getFlash(req, "success"),
            error: getFlash(req, "error"),
            routeFarePreview
        });
    } catch (err) {
        console.error("getFaresPage error:", err);
        return renderAdmin(req, res, "admin/fares", "Cau hinh bang gia ve", {
            path: "fares",
            matrix: null,
            matrixSource: "ERROR",
            tiersText: "",
            success: null,
            error: "Khong the tai cau hinh bang gia.",
            routeFarePreview: []
        });
    }
};

exports.updateFares = async (req, res) => {
    try {
        const singleRideBasePrice = toNumberOrNull(req.body.singleRideBasePrice);
        const interRoutePrice = toNumberOrNull(req.body.interRoutePrice);
        const singleRouteDefaultPrice = toNumberOrNull(req.body.singleRouteDefaultPrice);

        if (singleRideBasePrice === null || singleRideBasePrice < 0) {
            setFlash(req, "error", "Gia ve luot co ban khong hop le.");
            return res.redirect("/admin/fares");
        }
        if (interRoutePrice === null || interRoutePrice < 0) {
            setFlash(req, "error", "Gia ve thang lien tuyen khong hop le.");
            return res.redirect("/admin/fares");
        }
        if (singleRouteDefaultPrice === null || singleRouteDefaultPrice < 0) {
            setFlash(req, "error", "Gia ve thang don tuyen mac dinh khong hop le.");
            return res.redirect("/admin/fares");
        }

        const payload = {
            singleRide: {
                basePrice: Math.round(singleRideBasePrice),
                distanceTiers: parseTiers(req.body.tiersText)
            },
            monthly: {
                interRoutePrice: Math.round(interRoutePrice),
                singleRouteDefaultPrice: Math.round(singleRouteDefaultPrice)
            },
            priorityDiscounts: {
                defaultPercent: 20,
                studentPercent: null,
                warVeteranPercent: null,
                disabledPercent: null,
                elderlyPercent: null,
                otherPercent: null
            },
            freeRideRules: {
                enabled: req.body.freeRideEnabled === "on",
                underAge: toNumberOrNull(req.body.freeRideUnderAge),
                overAge: toNumberOrNull(req.body.freeRideOverAge),
                priorityCategories: [],
                note: clean(req.body.freeRideNote)
            }
        };

        await upsertFareMatrix(payload, req.session?.userId || null);
        setFlash(req, "success", "Da cap nhat bang gia ve thanh cong.");
        return res.redirect("/admin/fares");
    } catch (err) {
        console.error("updateFares error:", err);
        setFlash(req, "error", err.message || "Khong the cap nhat bang gia ve.");
        return res.redirect("/admin/fares");
    }
};
