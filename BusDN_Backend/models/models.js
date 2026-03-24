const mongoose = require('mongoose');

// --- 1. NGƯỜI DÙNG (USER) ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: false, unique: true, sparse: true, trim: true },
    password: { type: String, required: true },
    fullName: { type: String, default: 'Hành khách' },
    phone: {
        type: String,
        trim: true,
        unique: true,
        sparse: true,
        required: function reqPhone() {
            return !this.email;
        }
    },
    avatar: { type: String, default: '/images/default-avatar.png' },
    role: {
        type: String,
        enum: ['PASSENGER', 'DRIVER', 'CONDUCTOR', 'ASSISTANT', 'ADMIN', 'STAFF', 'FINANCE'],
        default: 'PASSENGER'
    },
    isVerified: { type: Boolean, default: false },
    isLocked: { type: Boolean, default: false },
    status: {
        type: String,
        enum: ['ACTIVE', 'LOCKED'],
        default: 'ACTIVE'
    },
    isFirstLogin: { type: Boolean, default: true },
    otp_code: String,
    otp_expires: Date,
    resetToken: { type: String, default: null },
    isPriorityGroup: { type: Boolean, default: false },
    priorityStatus: {
        type: String,
        enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
        default: 'NONE'
    },
    walletBalance: { type: Number, default: 0 },
    priorityProfile: {
        cardImageFront: String,
        cardImageBack: String,
        cardNumber: String,
        status: {
            type: String,
            enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
            default: 'NONE'
        },
        expiryDate: Date
    }
}, { timestamps: true });

UserSchema.pre('save', async function syncLockStatus() {
    if (this.status === 'LOCKED') {
        this.isLocked = true;
    } else if (this.status === 'ACTIVE') {
        this.isLocked = false;
    } else if (this.isModified('isLocked')) {
        this.status = this.isLocked ? 'LOCKED' : 'ACTIVE';
    }
});

// --- 2. ĐIỂM DỪNG (STOP) ---
const StopSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '', trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    isTerminal: { type: Boolean, default: false },
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

// --- 3. TUYẾN (ROUTE) ---
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
    /** Phút giữa 2 chuyến xuất bến (lịch / doc tần suất) */
    frequencyMinutes: { type: Number, default: 15, min: 1 },
    /** Thời gian chạy hết một vòng tuyến (phút) */
    roundTripMinutes: { type: Number, default: 60, min: 1 },
    /** Nghỉ giữa các chuyến / buffer (phút) */
    bufferMinutes: { type: Number, default: 10, min: 0 },
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

// --- 4. XE (BUS) ---
const BusSchema = new mongoose.Schema({
    licensePlate: { type: String, required: true, unique: true },
    brand: String,
    capacity: { type: Number, default: 45 },
    status: { type: String, enum: ['READY', 'RUNNING', 'MAINTENANCE'], default: 'READY' }
}, { timestamps: true });

// --- 5. LỊCH CHẠY (SCHEDULE) ---
const ScheduleSchema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    conductorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', default: null },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },
    date: { type: Date, required: true },
    departureTime: { type: String, default: null },
    slotDurationMinutes: { type: Number, default: null },
    shiftTime: {
        start: String,
        end: String
    },
    status: {
        type: String,
        enum: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
        default: 'SCHEDULED'
    },
    archived: { type: Boolean, default: false },
    actualStart: { type: String, default: null },
    actualEnd: { type: String, default: null },
    passengerCount: { type: Number, default: 0 },
    loadStatus: {
        type: String,
        enum: ['NORMAL', 'MODERATE', 'CROWDED', 'FULL'],
        default: 'NORMAL'
    },
    loadUpdatedAt: { type: Date, default: null },
    trackingActive: { type: Boolean, default: false },
    currentLocation: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        accuracy: { type: Number, default: null },
        speed: { type: Number, default: null },
        heading: { type: Number, default: null },
        updatedAt: { type: Date, default: null }
    },
    revenue: { type: Number, default: 0 },
    notes: { type: String, default: '' }
}, { timestamps: true });

ScheduleSchema.index({ routeId: 1, date: 1 });
ScheduleSchema.index({ driverId: 1, date: 1 });
ScheduleSchema.index({ busId: 1, date: 1 });

// --- 6. HỒ SƠ ƯU TIÊN ---
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
    expiryDate: { type: Date, default: null }
}, { timestamps: true });

const PriorityHistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'PriorityProfile', required: true },
    action: {
        type: String,
        enum: ['REJECTED'],
        default: 'REJECTED'
    },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

const PhoneVerificationSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, trim: true },
    firebaseUid: { type: String, default: null },
    verifiedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    consumed: { type: Boolean, default: false }
}, { timestamps: true });

PhoneVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// --- 7. GIAO DỊCH VÍ ---
const WalletTransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    txnRef: { type: String, unique: true, sparse: true },
    amount: { type: Number, required: true },
    direction: { type: String, enum: ['IN', 'OUT'], required: true },
    txnType: { type: String, enum: ['DEPOSIT', 'MONTHLY_PASS', 'TICKET'], required: true },
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
    vnpTransactionNo: { type: String, default: '' },
    bankCode: { type: String, default: '' },
    cardType: { type: String, default: '' },
    payDate: { type: String, default: '' },
    responseCode: { type: String, default: '' },
    transactionStatus: { type: String, default: '' },
    originalAmount: { type: Number, default: null },
    discountAmount: { type: Number, default: 0 },
    relatedMonthlyPassId: { type: mongoose.Schema.Types.ObjectId, ref: 'MonthlyPass', default: null },
    rawReturn: { type: Object, default: null },
    rawIpn: { type: Object, default: null },
    paidAt: { type: Date, default: null }
}, { timestamps: true });

// --- 8. VÉ THÁNG ---
const MonthlyPassSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    passType: {
        type: String,
        enum: ['SINGLE_ROUTE', 'INTER_ROUTE'],
        default: 'SINGLE_ROUTE'
    },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },
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
    originalPrice: { type: Number, default: null },
    discountAmount: { type: Number, default: 0 },
    paidBy: { type: String, enum: ['WALLET', 'PAYOS', 'VNPAY', 'MOMO'], default: 'WALLET' },
    status: {
        type: String,
        enum: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
        default: 'ACTIVE'
    }
}, { timestamps: true });

MonthlyPassSchema.index({ userId: 1, routeId: 1, month: 1, year: 1 }, { unique: true });

// --- 8.1 VÉ LẺ THEO CHUYẾN ---
const TripTicketSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Schedule', required: true },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },
    seatLabel: { type: String, required: true, trim: true },
    pricePaid: { type: Number, required: true },
    qrCode: { type: String, required: true, unique: true, trim: true },
    status: {
        type: String,
        enum: ['BOOKED', 'USED', 'CANCELLED'],
        default: 'BOOKED'
    },
    usedAt: { type: Date, default: null }
}, { timestamps: true });

TripTicketSchema.index({ scheduleId: 1, seatLabel: 1, status: 1 });

// --- 9. THÔNG BÁO IN-APP ---
const NotificationSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    audience: {
        type: String,
        enum: ['ALL', 'DRIVERS', 'CONDUCTORS'],
        default: 'ALL'
    },
    targetRoles: [{
        type: String,
        enum: ['PASSENGER', 'DRIVER', 'CONDUCTOR', 'ADMIN']
    }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sentAt: { type: Date, default: Date.now }
}, { timestamps: true });

// --- 10. MẤT ĐỒ ---
const LostFoundSchema = new mongoose.Schema({
    description: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    reporter: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    date: { type: Date, default: Date.now },
    status: {
        type: String,
        enum: ['PENDING', 'RESOLVED', 'CLOSED'],
        default: 'PENDING'
    },
    notes: { type: String, default: '' }
}, { timestamps: true });

// --- 11. PHẢN HỒI ---
const FeedbackSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    subject: { type: String, default: '', trim: true },
    message: { type: String, required: true, trim: true },
    rating: { type: Number, min: 1, max: 5, default: null },
    category: {
        type: String,
        enum: ['COMPLAINT', 'SUGGESTION', 'PRAISE', 'OTHER'],
        default: 'COMPLAINT'
    },
    status: {
        type: String,
        enum: ['NEW', 'IN_PROGRESS', 'RESPONDED', 'CLOSED'],
        default: 'NEW'
    },
    adminReply: { type: String, default: '', trim: true },
    repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    repliedAt: { type: Date, default: null }
}, { timestamps: true });

// --- UC Marketing: khuyến mãi ---
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
    PriorityHistory: mongoose.models.PriorityHistory || mongoose.model('PriorityHistory', PriorityHistorySchema),
    PhoneVerification: mongoose.models.PhoneVerification || mongoose.model('PhoneVerification', PhoneVerificationSchema),
    WalletTransaction: mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', WalletTransactionSchema),
    MonthlyPass: mongoose.models.MonthlyPass || mongoose.model('MonthlyPass', MonthlyPassSchema),
    TripTicket: mongoose.models.TripTicket || mongoose.model('TripTicket', TripTicketSchema),
    Notification: mongoose.models.Notification || mongoose.model('Notification', NotificationSchema),
    LostFound: mongoose.models.LostFound || mongoose.model('LostFound', LostFoundSchema),
    Feedback: mongoose.models.Feedback || mongoose.model('Feedback', FeedbackSchema),
    Promotion: mongoose.models.Promotion || mongoose.model('Promotion', PromotionSchema),
    FareMatrix: mongoose.models.FareMatrix || mongoose.model('FareMatrix', FareMatrixSchema)
};
