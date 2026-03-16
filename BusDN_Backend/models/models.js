const mongoose = require('mongoose');

// --- 1. NGƯỜI DÙNG (USER) ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: false, unique: true, sparse: true, trim: true },
    password: { type: String, required: true },
    fullName: { type: String, default: "Hành khách" },
    phone: {
        type: String,
        trim: true,
        unique: true,
        sparse: true,
        required: function () {
            return !this.email;
        }
    },
    avatar: { type: String, default: "/images/default-avatar.png" },
    role: {
        type: String,
        enum: ['PASSENGER', 'DRIVER', 'CONDUCTOR', 'ADMIN'], // CONDUCTOR = ASSISTANT (Phụ xe)
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

    // Tài chính (Từ Model 2)
    walletBalance: { type: Number, default: 0 },

    // Hồ sơ ưu tiên (Tích hợp từ Model 1)
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

UserSchema.pre('save', async function () { // Bỏ next
    if (this.status === 'LOCKED') {
        this.isLocked = true;
    } else if (this.status === 'ACTIVE') {
        this.isLocked = false;
    } else if (this.isModified('isLocked')) {
        this.status = this.isLocked ? 'LOCKED' : 'ACTIVE';
    }
    // Không gọi next() nữa, chỉ cần kết thúc hàm là xong
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

// --- 3. TUYẾN ĐƯỜNG (ROUTE) ---
const RouteSchema = new mongoose.Schema({
    routeNumber: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    distance: { type: Number, default: 0 },
    monthlyPassPrice: { type: Number, default: 200000 },
    status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE'],
        default: 'ACTIVE'
    },
    operationTime: {
        start: { type: String, default: "05:00" },
        end: { type: String, default: "21:00" }
    },
    stops: [{
        stopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop' },
        orderIndex: Number,
        direction: { type: String, enum: ['OUTBOUND', 'INBOUND'] }, // Đi và Về
        distanceFromStart: Number
    }]
}, { timestamps: true });

// --- 4. XE BUÝT (BUS) ---
const BusSchema = new mongoose.Schema({
    licensePlate: { type: String, required: true, unique: true },
    brand: String,
    capacity: { type: Number, default: 45 },
    status: {
        type: String,
        enum: ['READY', 'RUNNING', 'MAINTENANCE'],
        default: 'READY'
    }
}, { timestamps: true });

// --- 5. LỊCH CHẠY (SCHEDULE) ---
const ScheduleSchema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    conductorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // Phụ xe
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', default: null },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },
    date: { type: Date, required: true },
    shiftTime: {
        start: String,
        end: String
    },
    // Trip log fields (updated after completion)
    actualStart: { type: String, default: null },
    actualEnd: { type: String, default: null },
    passengerCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    notes: { type: String, default: '' }
}, { timestamps: true });

// --- 6. HỒ SƠ ƯU TIÊN CHI TIẾT (PRIORITY PROFILE - Model 1) ---
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

// --- 7. GIAO DỊCH VÍ (WALLET TRANSACTION - Model 2) ---
const WalletTransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    txnRef: { type: String, unique: true, sparse: true }, // Mã tham chiếu VNPAY
    amount: { type: Number, required: true },
    direction: { type: String, enum: ['IN', 'OUT'], required: true },
    txnType: { type: String, enum: ['DEPOSIT', 'MONTHLY_PASS'], required: true },
    note: { type: String, default: '' },
    method: { type: String, enum: ['VNPAY', 'WALLET'], default: 'VNPAY' },
    status: {
        type: String,
        enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'],
        default: 'PENDING'
    },
    vnpTransactionNo: String,
    bankCode: String,
    payDate: String,
    originalAmount: { type: Number, default: null },
    discountAmount: { type: Number, default: 0 },
    relatedMonthlyPassId: { type: mongoose.Schema.Types.ObjectId, ref: 'MonthlyPass', default: null }
}, { timestamps: true });

// --- 8. VÉ THÁNG (MONTHLY PASS - Model 2) ---
const MonthlyPassSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },
    routeSnapshot: {
        routeNumber: String,
        name: String
    },
    passCode: { type: String, required: true, unique: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    validFrom: Date,
    validTo: Date,
    pricePaid: Number,
    originalPrice: { type: Number, default: null },
    discountAmount: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
        default: 'ACTIVE'
    }
}, { timestamps: true });

// Index để tránh mua trùng vé cùng tuyến trong cùng 1 tháng
MonthlyPassSchema.index({ userId: 1, routeId: 1, month: 1, year: 1 }, { unique: true });

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

// --- 10. BÁO CÁO MẤT ĐỒ ---
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

// --- 11. PHẢN HỒI / KHIẾU NẠI KHÁCH HÀNG ---
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

// --- XUẤT MODELS ---
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
    Notification: mongoose.models.Notification || mongoose.model('Notification', NotificationSchema),
    LostFound: mongoose.models.LostFound || mongoose.model('LostFound', LostFoundSchema),
    Feedback: mongoose.models.Feedback || mongoose.model('Feedback', FeedbackSchema)
};
