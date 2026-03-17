const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullName: { type: String, default: "Hành khách" },
    phone: { type: String },
    avatar: { type: String, default: "/images/default-avatar.png" },
    role: {
        type: String,
        enum: ['PASSENGER', 'DRIVER', 'ASSISTANT', 'ADMIN', 'FINANCE'],
        default: 'PASSENGER'
    },
    isVerified: { type: Boolean, default: false },
    otp_code: String,
    otp_expires: Date,

    // UC13/14/15 - số dư ví

    priorityProfile: {
        cardImageFront: String,
        cardImageBack: String,
        cardNumber: String,
        status: {
            type: String,
            enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'],
            default: 'NONE'
        },
        expiryDate: Date
    }
}, { timestamps: true });

const StopSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '', trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    isTerminal: { type: Boolean, default: false },

    // thêm để CRUD mềm
    status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE'],
        default: 'ACTIVE'
    }
}, { timestamps: true });

const RouteDirectionStopSchema = new mongoose.Schema({
    stopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop', required: true },
    sequenceOrder: { type: Number, required: true },
    estimatedMinutesFromStart: { type: Number, default: 0 },
    distanceFromStart: { type: Number, default: 0 },
    pickupAllowed: { type: Boolean, default: true },
    dropoffAllowed: { type: Boolean, default: true },
    status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE'],
        default: 'ACTIVE'
    }
}, { _id: false });

const RouteDirectionSchema = new mongoose.Schema({
    directionKey: {
        type: String,
        enum: ['OUTBOUND', 'INBOUND'],
        required: true
    },
    startStopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop', default: null },
    endStopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop', default: null },
    stops: { type: [RouteDirectionStopSchema], default: [] }
}, { _id: false });

const RouteOperationSettingsSchema = new mongoose.Schema({
    operatingDays: { type: [String], default: [] },
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },
    tripInterval: { type: Number, default: null },
    estimatedRouteDuration: { type: Number, default: null },
    turnaroundTime: { type: Number, default: null },
    notes: { type: String, default: '' }
}, { _id: false });

const RouteAuditLogSchema = new mongoose.Schema({
    action: { type: String, required: true, trim: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    message: { type: String, default: '' },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    performedAt: { type: Date, default: Date.now }
}, { _id: false });

const RouteSchema = new mongoose.Schema({
    routeNumber: { type: String, required: true, unique: true, trim: true },
    name: { type: String, default: '', trim: true },
    description: { type: String, default: '' },
    distance: { type: Number, default: 0 },
    routeType: { type: String, default: '' },
    serviceType: { type: String, default: '' },
    startStopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop', default: null },
    endStopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop', default: null },
    effectiveDate: { type: Date, default: null },

    // UC15 - giá vé tháng theo tuyến
    monthlyPassPrice: { type: Number, default: 200000 },

    status: {
        type: String,
        enum: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'INACTIVE'],
        default: 'DRAFT'
    },
    operationTime: {
        start: String,
        end: String
    },
    operationSettings: {
        type: RouteOperationSettingsSchema,
        default: () => ({})
    },
    directions: {
        outbound: {
            type: RouteDirectionSchema,
            default: () => ({ directionKey: 'OUTBOUND', stops: [] })
        },
        inbound: {
            type: RouteDirectionSchema,
            default: () => ({ directionKey: 'INBOUND', stops: [] })
        }
    },
    auditLogs: { type: [RouteAuditLogSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    stops: [{
        stopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop' },
        orderIndex: Number,
        direction: { type: String, enum: ['OUTBOUND', 'INBOUND'] },
        distanceFromStart: Number
    }]
}, { timestamps: true });

const BusSchema = new mongoose.Schema({
    licensePlate: { type: String, required: true, unique: true },
    brand: String,
    capacity: { type: Number, default: 45 },
    status: { type: String, enum: ['READY', 'RUNNING', 'MAINTENANCE'], default: 'READY' }
}, { timestamps: true });

const ScheduleSchema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus' },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
    date: Date,
    shiftTime: {
        start: String,
        end: String
    }
}, { timestamps: true });

const PriorityProfileSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    category: {
        type: String,
        enum: ['Student', 'War Veteran', 'Disabled', 'Elderly', 'Other'],
        required: true
    },
    idNumber: { type: String, required: true },
    idCardImageFront: { type: String, required: true },
    idCardImageBack: { type: String, required: true },
    proofImage: { type: String, required: true },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    rejectionReason: { type: String, default: null },
    expiryDate: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// UC13/14/15 - lịch sử giao dịch ví
const WalletTransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // VNPAY: txnRef phía merchant
    txnRef: { type: String, unique: true, sparse: true },

    amount: { type: Number, required: true },
    direction: { type: String, enum: ['IN', 'OUT'], required: true },
    txnType: { type: String, enum: ['DEPOSIT', 'MONTHLY_PASS'], required: true },

    note: { type: String, default: '' },

    method: {
        type: String,
        enum: ['VNPAY', 'MOMO', 'WALLET', 'PAYOS'],
        default: 'VNPAY'
    },

    status: {
        type: String,
        enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'],
        default: 'PENDING'
    },

    // VNPAY fields
    vnpTransactionNo: { type: String, default: '' },
    bankCode: { type: String, default: '' },
    cardType: { type: String, default: '' },
    payDate: { type: String, default: '' },
    responseCode: { type: String, default: '' },
    transactionStatus: { type: String, default: '' },

    // liên kết UC15
    relatedMonthlyPassId: { type: mongoose.Schema.Types.ObjectId, ref: 'MonthlyPass', default: null },

    rawReturn: { type: Object, default: null },
    rawIpn: { type: Object, default: null },
    paidAt: { type: Date, default: null }
}, { timestamps: true });

// UC15 - vé tháng
const MonthlyPassSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    passType: {
        type: String,
        enum: ['SINGLE_ROUTE', 'INTER_ROUTE'],
        default: 'SINGLE_ROUTE'
    },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', default: null },

    // snapshot để vẫn hiện tên tuyến nếu route bị xóa sau này
    routeSnapshot: {
        routeNumber: { type: String, default: '' },
        name: { type: String, default: '' }
    },

    passCode: { type: String, required: true, unique: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },

    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },

    pricePaid: { type: Number, required: true },
    paidBy: { type: String, enum: ['WALLET', 'PAYOS', 'VNPAY', 'MOMO'], default: 'WALLET' },

    status: {
        type: String,
        enum: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
        default: 'ACTIVE'
    }
}, { timestamps: true });

// 1 user không được mua trùng cùng 1 tuyến, không phân biệt tháng/năm
MonthlyPassSchema.index(
    { userId: 1, passType: 1, routeId: 1, month: 1, year: 1 },
    { unique: true }
);

// UC Marketing - chuong trinh khuyen mai
const PromotionSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },

    discountType: {
        type: String,
        enum: ['PERCENT', 'FIXED'],
        default: 'PERCENT'
    },
    discountValue: { type: Number, required: true, min: 0 },
    maxDiscountValue: { type: Number, default: null, min: 0 },
    minOrderValue: { type: Number, default: 0, min: 0 },

    applyScope: {
        type: String,
        enum: ['ALL', 'SINGLE_ROUTE', 'INTER_ROUTE'],
        default: 'ALL'
    },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', default: null },

    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },

    status: {
        type: String,
        enum: ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED'],
        default: 'DRAFT'
    },
    endedEarlyAt: { type: Date, default: null },

    usageLimitTotal: { type: Number, default: null, min: 1 },
    usageLimitPerUser: { type: Number, default: 1, min: 1 },
    usageCount: { type: Number, default: 0, min: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

PromotionSchema.index({ status: 1, startAt: 1, endAt: 1 });
PromotionSchema.index({ code: 1 }, { unique: true });

const FareTierSchema = new mongoose.Schema({
    maxDistanceKm: { type: Number, default: null },
    price: { type: Number, required: true, min: 0 }
}, { _id: false });

const FareMatrixSchema = new mongoose.Schema({
    code: { type: String, default: 'DEFAULT', unique: true, uppercase: true, trim: true },
    singleRide: {
        basePrice: { type: Number, default: 7000, min: 0 },
        distanceTiers: { type: [FareTierSchema], default: [] }
    },
    monthly: {
        interRoutePrice: { type: Number, default: 300000, min: 0 },
        singleRouteDefaultPrice: { type: Number, default: 200000, min: 0 }
    },
    priorityDiscounts: {
        defaultPercent: { type: Number, default: 20, min: 0, max: 100 },
        studentPercent: { type: Number, default: null, min: 0, max: 100 },
        warVeteranPercent: { type: Number, default: null, min: 0, max: 100 },
        disabledPercent: { type: Number, default: null, min: 0, max: 100 },
        elderlyPercent: { type: Number, default: null, min: 0, max: 100 },
        otherPercent: { type: Number, default: null, min: 0, max: 100 }
    },
    freeRideRules: {
        enabled: { type: Boolean, default: true },
        underAge: { type: Number, default: 6, min: 0, max: 120 },
        overAge: { type: Number, default: 80, min: 0, max: 120 },
        priorityCategories: { type: [String], default: ['disabled', 'war veteran'] },
        note: { type: String, default: '' }
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = {
    User: mongoose.models.User || mongoose.model('User', UserSchema),
    Stop: mongoose.models.Stop || mongoose.model('Stop', StopSchema),
    Route: mongoose.models.Route || mongoose.model('Route', RouteSchema),
    Bus: mongoose.models.Bus || mongoose.model('Bus', BusSchema),
    Schedule: mongoose.models.Schedule || mongoose.model('Schedule', ScheduleSchema),
    PriorityProfile: mongoose.models.PriorityProfile || mongoose.model('PriorityProfile', PriorityProfileSchema),
    WalletTransaction: mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', WalletTransactionSchema),
    MonthlyPass: mongoose.models.MonthlyPass || mongoose.model('MonthlyPass', MonthlyPassSchema),
    Promotion: mongoose.models.Promotion || mongoose.model('Promotion', PromotionSchema),
    FareMatrix: mongoose.models.FareMatrix || mongoose.model('FareMatrix', FareMatrixSchema)
};
