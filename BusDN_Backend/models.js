const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullName: { type: String, default: "Hành khách" },
    phone: { type: String },
    avatar: { type: String, default: "/images/default-avatar.png" },
    role: {
        type: String,
        enum: ['PASSENGER', 'DRIVER', 'ASSISTANT', 'ADMIN'],
        default: 'PASSENGER'
    },
    isVerified: { type: Boolean, default: false },
    otp_code: String,
    otp_expires: Date,

    // UC13/14/15 - số dư ví
    walletBalance: { type: Number, default: 0 },

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

const RouteSchema = new mongoose.Schema({
    routeNumber: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    distance: { type: Number, default: 0 },

    // UC15 - giá vé tháng theo tuyến
    monthlyPassPrice: { type: Number, default: 200000 },

    status: {
        type: String,
        enum: ['ACTIVE', 'INACTIVE'],
        default: 'ACTIVE'
    },
    operationTime: {
        start: String,
        end: String
    },

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
        enum: ['VNPAY', 'WALLET'],
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
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true },

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
    paidBy: { type: String, enum: ['WALLET'], default: 'WALLET' },

    status: {
        type: String,
        enum: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
        default: 'ACTIVE'
    }
}, { timestamps: true });

// 1 user không được mua trùng cùng 1 tuyến, không phân biệt tháng/năm
MonthlyPassSchema.index(
    { userId: 1, routeId: 1, month: 1, year: 1 },
    { unique: true }
);

module.exports = {
    User: mongoose.models.User || mongoose.model('User', UserSchema),
    Stop: mongoose.models.Stop || mongoose.model('Stop', StopSchema),
    Route: mongoose.models.Route || mongoose.model('Route', RouteSchema),
    Bus: mongoose.models.Bus || mongoose.model('Bus', BusSchema),
    Schedule: mongoose.models.Schedule || mongoose.model('Schedule', ScheduleSchema),
    WalletTransaction: mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', WalletTransactionSchema),
    MonthlyPass: mongoose.models.MonthlyPass || mongoose.model('MonthlyPass', MonthlyPassSchema)
};