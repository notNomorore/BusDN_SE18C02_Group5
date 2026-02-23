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
    name: { type: String, required: true },
    address: String,
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    isTerminal: { type: Boolean, default: false }
}, { timestamps: true });

const RouteSchema = new mongoose.Schema({
    routeNumber: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    distance: { type: Number, default: 0 },
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

module.exports = {
    User: mongoose.models.User || mongoose.model('User', UserSchema),
    Stop: mongoose.models.Stop || mongoose.model('Stop', StopSchema),
    Route: mongoose.models.Route || mongoose.model('Route', RouteSchema),
    Bus: mongoose.models.Bus || mongoose.model('Bus', BusSchema),
    Schedule: mongoose.models.Schedule || mongoose.model('Schedule', ScheduleSchema)
};
