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
    otp_code: String, // Store 6-digit OTP temporarily
    otp_expires: Date, // Expiry time for OTP

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
});

const RouteSchema = new mongoose.Schema({
    routeNumber: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    distance: Number, 
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
});

const BusSchema = new mongoose.Schema({
    licensePlate: { type: String, required: true, unique: true }, 
    brand: String, 
    capacity: { type: Number, default: 45 }, 
    status: { type: String, enum: ['READY', 'RUNNING', 'MAINTENANCE'], default: 'READY' }
});

const ScheduleSchema = new mongoose.Schema({
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus' },
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route' },
    date: Date, 
    shiftTime: {
        start: String,
        end: String
    }
});

module.exports = {
    User: mongoose.model('User', UserSchema),
    Stop: mongoose.model('Stop', StopSchema),
    Route: mongoose.model('Route', RouteSchema),
    Bus: mongoose.model('Bus', BusSchema),
    Schedule: mongoose.model('Schedule', ScheduleSchema)
};