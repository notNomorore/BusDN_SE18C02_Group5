const mongoose = require('mongoose');

// --- 1. NGƯỜI DÙNG (USER) ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    fullName: { type: String, default: "Hành khách" },
    phone: { type: String },
    avatar: { type: String, default: "/images/default-avatar.png" },
    role: {
        type: String,
        enum: ['PASSENGER', 'DRIVER', 'CONDUCTOR', 'ADMIN'], // CONDUCTOR = ASSISTANT (Phụ xe)
        default: 'PASSENGER'
    },
    isVerified: { type: Boolean, default: false },
    isLocked: { type: Boolean, default: false },
    otp_code: String,
    otp_expires: Date,

    // Tài chính (Từ Model 2)
    walletBalance: { type: Number, default: 0 },

    // Hồ sơ ưu tiên (Tích hợp từ Model 1)
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
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus' },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
    date: { type: Date, required: true },
    shiftTime: {
        start: String,
        end: String
    }
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
    status: {
        type: String,
        enum: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
        default: 'ACTIVE'
    }
}, { timestamps: true });

// Index để tránh mua trùng vé cùng tuyến trong cùng 1 tháng
MonthlyPassSchema.index({ userId: 1, routeId: 1, month: 1, year: 1 }, { unique: true });

// --- XUẤT MODELS ---
module.exports = {
    User: mongoose.models.User || mongoose.model('User', UserSchema),
    Stop: mongoose.models.Stop || mongoose.model('Stop', StopSchema),
    Route: mongoose.models.Route || mongoose.model('Route', RouteSchema),
    Bus: mongoose.models.Bus || mongoose.model('Bus', BusSchema),
    Schedule: mongoose.models.Schedule || mongoose.model('Schedule', ScheduleSchema),
    PriorityProfile: mongoose.models.PriorityProfile || mongoose.model('PriorityProfile', PriorityProfileSchema),
    WalletTransaction: mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', WalletTransactionSchema),
    MonthlyPass: mongoose.models.MonthlyPass || mongoose.model('MonthlyPass', MonthlyPassSchema)
};