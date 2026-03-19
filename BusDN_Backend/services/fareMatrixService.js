const { FareMatrix } = require("../models");

const PASS_TYPE = {
    SINGLE_ROUTE: "SINGLE_ROUTE",
    INTER_ROUTE: "INTER_ROUTE"
};

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function toNonNegative(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
}

function normalizeCategoryKey(raw) {
    return String(raw || "").trim().toLowerCase();
}

function getDefaultFareMatrix() {
    return {
        code: "DEFAULT",
        singleRide: {
            basePrice: toNonNegative(process.env.SINGLE_RIDE_BASE_PRICE, 7000),
            distanceTiers: [
                { maxDistanceKm: 5, price: 7000 },
                { maxDistanceKm: 10, price: 10000 },
                { maxDistanceKm: 20, price: 15000 },
                { maxDistanceKm: null, price: 20000 }
            ]
        },
        monthly: {
            interRoutePrice: toNonNegative(process.env.INTER_ROUTE_MONTHLY_PRICE, 300000),
            singleRouteDefaultPrice: toNonNegative(process.env.SINGLE_ROUTE_MONTHLY_DEFAULT_PRICE, 200000)
        },
        priorityDiscounts: {
            defaultPercent: clampNumber(process.env.PRIORITY_DISCOUNT_DEFAULT_PERCENT, 0, 100, 20),
            studentPercent: process.env.PRIORITY_DISCOUNT_STUDENT_PERCENT === undefined
                ? null
                : clampNumber(process.env.PRIORITY_DISCOUNT_STUDENT_PERCENT, 0, 100, 20),
            warVeteranPercent: process.env.PRIORITY_DISCOUNT_WAR_VETERAN_PERCENT === undefined
                ? null
                : clampNumber(process.env.PRIORITY_DISCOUNT_WAR_VETERAN_PERCENT, 0, 100, 20),
            disabledPercent: process.env.PRIORITY_DISCOUNT_DISABLED_PERCENT === undefined
                ? null
                : clampNumber(process.env.PRIORITY_DISCOUNT_DISABLED_PERCENT, 0, 100, 20),
            elderlyPercent: process.env.PRIORITY_DISCOUNT_ELDERLY_PERCENT === undefined
                ? null
                : clampNumber(process.env.PRIORITY_DISCOUNT_ELDERLY_PERCENT, 0, 100, 20),
            otherPercent: process.env.PRIORITY_DISCOUNT_OTHER_PERCENT === undefined
                ? null
                : clampNumber(process.env.PRIORITY_DISCOUNT_OTHER_PERCENT, 0, 100, 20)
        },
        freeRideRules: {
            enabled: true,
            underAge: 6,
            overAge: 80,
            priorityCategories: ["disabled", "war veteran"],
            note: "Ap dung mien phi theo tuoi va doi tuong uu tien."
        },
        active: true
    };
}

function normalizeDistanceTiers(rawTiers) {
    const rows = Array.isArray(rawTiers) ? rawTiers : [];
    const normalized = rows
        .map((row) => ({
            maxDistanceKm: row?.maxDistanceKm === null || row?.maxDistanceKm === undefined || row?.maxDistanceKm === ""
                ? null
                : Number(row.maxDistanceKm),
            price: Number(row?.price)
        }))
        .filter((row) => Number.isFinite(row.price) && row.price >= 0)
        .map((row) => ({
            maxDistanceKm: row.maxDistanceKm === null
                ? null
                : (Number.isFinite(row.maxDistanceKm) && row.maxDistanceKm > 0 ? row.maxDistanceKm : null),
            price: Math.round(row.price)
        }));

    if (!normalized.length) {
        return getDefaultFareMatrix().singleRide.distanceTiers;
    }

    const finite = normalized
        .filter((r) => r.maxDistanceKm !== null)
        .sort((a, b) => a.maxDistanceKm - b.maxDistanceKm);
    const inf = normalized.find((r) => r.maxDistanceKm === null);
    if (inf) finite.push(inf);
    return finite;
}

function normalizeFareMatrix(input, fallback = getDefaultFareMatrix()) {
    const src = input || {};
    const out = {
        ...fallback,
        code: String(src.code || fallback.code || "DEFAULT").toUpperCase(),
        singleRide: {
            basePrice: toNonNegative(src?.singleRide?.basePrice, fallback.singleRide.basePrice),
            distanceTiers: normalizeDistanceTiers(src?.singleRide?.distanceTiers || fallback.singleRide.distanceTiers)
        },
        monthly: {
            interRoutePrice: toNonNegative(src?.monthly?.interRoutePrice, fallback.monthly.interRoutePrice),
            singleRouteDefaultPrice: toNonNegative(
                src?.monthly?.singleRouteDefaultPrice,
                fallback.monthly.singleRouteDefaultPrice
            )
        },
        priorityDiscounts: {
            defaultPercent: clampNumber(
                src?.priorityDiscounts?.defaultPercent,
                0,
                100,
                fallback.priorityDiscounts.defaultPercent
            ),
            studentPercent: src?.priorityDiscounts?.studentPercent === null || src?.priorityDiscounts?.studentPercent === undefined || src?.priorityDiscounts?.studentPercent === ""
                ? null
                : clampNumber(src.priorityDiscounts.studentPercent, 0, 100, fallback.priorityDiscounts.defaultPercent),
            warVeteranPercent: src?.priorityDiscounts?.warVeteranPercent === null || src?.priorityDiscounts?.warVeteranPercent === undefined || src?.priorityDiscounts?.warVeteranPercent === ""
                ? null
                : clampNumber(src.priorityDiscounts.warVeteranPercent, 0, 100, fallback.priorityDiscounts.defaultPercent),
            disabledPercent: src?.priorityDiscounts?.disabledPercent === null || src?.priorityDiscounts?.disabledPercent === undefined || src?.priorityDiscounts?.disabledPercent === ""
                ? null
                : clampNumber(src.priorityDiscounts.disabledPercent, 0, 100, fallback.priorityDiscounts.defaultPercent),
            elderlyPercent: src?.priorityDiscounts?.elderlyPercent === null || src?.priorityDiscounts?.elderlyPercent === undefined || src?.priorityDiscounts?.elderlyPercent === ""
                ? null
                : clampNumber(src.priorityDiscounts.elderlyPercent, 0, 100, fallback.priorityDiscounts.defaultPercent),
            otherPercent: src?.priorityDiscounts?.otherPercent === null || src?.priorityDiscounts?.otherPercent === undefined || src?.priorityDiscounts?.otherPercent === ""
                ? null
                : clampNumber(src.priorityDiscounts.otherPercent, 0, 100, fallback.priorityDiscounts.defaultPercent)
        },
        freeRideRules: {
            enabled: Boolean(src?.freeRideRules?.enabled ?? fallback.freeRideRules.enabled),
            underAge: clampNumber(src?.freeRideRules?.underAge, 0, 120, fallback.freeRideRules.underAge),
            overAge: clampNumber(src?.freeRideRules?.overAge, 0, 120, fallback.freeRideRules.overAge),
            priorityCategories: Array.isArray(src?.freeRideRules?.priorityCategories)
                ? src.freeRideRules.priorityCategories.map(normalizeCategoryKey).filter(Boolean)
                : fallback.freeRideRules.priorityCategories,
            note: String(src?.freeRideRules?.note || fallback.freeRideRules.note || "").trim()
        },
        active: src?.active !== false
    };
    return out;
}

async function getFareMatrix() {
    const defaultConfig = getDefaultFareMatrix();
    const doc = await FareMatrix.findOne({ code: "DEFAULT", active: true }).lean();
    if (!doc) {
        return { matrix: normalizeFareMatrix(defaultConfig, defaultConfig), source: "DEFAULT" };
    }
    return { matrix: normalizeFareMatrix(doc, defaultConfig), source: "DB" };
}

async function upsertFareMatrix(payload, userId = null) {
    const fallback = getDefaultFareMatrix();
    const matrix = normalizeFareMatrix(payload, fallback);
    return FareMatrix.findOneAndUpdate(
        { code: "DEFAULT" },
        { $set: { ...matrix, updatedBy: userId || null, code: "DEFAULT", active: true } },
        { upsert: true, new: true }
    );
}

function getPriorityDiscountPercentByCategory(category, matrix) {
    const config = matrix || getDefaultFareMatrix();
    const key = normalizeCategoryKey(category);
    const mapping = {
        student: config?.priorityDiscounts?.studentPercent,
        "war veteran": config?.priorityDiscounts?.warVeteranPercent,
        disabled: config?.priorityDiscounts?.disabledPercent,
        elderly: config?.priorityDiscounts?.elderlyPercent,
        other: config?.priorityDiscounts?.otherPercent
    };
    const byCategory = mapping[key];
    if (byCategory !== null && byCategory !== undefined && byCategory !== "") {
        return clampNumber(byCategory, 0, 100, 0);
    }
    return clampNumber(config?.priorityDiscounts?.defaultPercent, 0, 100, 0);
}

function resolveMonthlyPassBasePrice(passType, routeMonthlyPassPrice, matrix) {
    const config = matrix || getDefaultFareMatrix();
    if (passType === PASS_TYPE.INTER_ROUTE) {
        return toNonNegative(config?.monthly?.interRoutePrice, 0);
    }

    const routePrice = Number(routeMonthlyPassPrice);
    if (Number.isFinite(routePrice) && routePrice > 0) {
        return routePrice;
    }
    return toNonNegative(config?.monthly?.singleRouteDefaultPrice, 0);
}

function estimateSingleRideFare(distanceKm, matrix) {
    const config = matrix || getDefaultFareMatrix();
    const d = Number(distanceKm);
    const safeDistance = Number.isFinite(d) && d > 0 ? d : 0;
    const tiers = normalizeDistanceTiers(config?.singleRide?.distanceTiers || []);
    for (const row of tiers) {
        if (row.maxDistanceKm === null || safeDistance <= row.maxDistanceKm) {
            return Math.round(toNonNegative(row.price, config.singleRide.basePrice));
        }
    }
    return Math.round(toNonNegative(config?.singleRide?.basePrice, 0));
}

function isEligibleForFreeRide({ age, priorityCategory }, matrix) {
    const config = matrix || getDefaultFareMatrix();
    const rules = config?.freeRideRules || {};
    if (!rules.enabled) return false;

    const normalizedCategory = normalizeCategoryKey(priorityCategory);
    const categories = Array.isArray(rules.priorityCategories)
        ? rules.priorityCategories.map(normalizeCategoryKey).filter(Boolean)
        : [];
    if (normalizedCategory && categories.includes(normalizedCategory)) return true;

    const nAge = Number(age);
    if (Number.isFinite(nAge) && nAge >= 0) {
        if (Number.isFinite(Number(rules.underAge)) && nAge < Number(rules.underAge)) return true;
        if (Number.isFinite(Number(rules.overAge)) && nAge >= Number(rules.overAge)) return true;
    }
    return false;
}

module.exports = {
    PASS_TYPE,
    getDefaultFareMatrix,
    getFareMatrix,
    upsertFareMatrix,
    getPriorityDiscountPercentByCategory,
    resolveMonthlyPassBasePrice,
    estimateSingleRideFare,
    isEligibleForFreeRide,
    normalizeFareMatrix
};
