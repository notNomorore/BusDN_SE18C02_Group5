const { Schedule, Bus, Route, User } = require('../models/models');

// === BUS (FLEET) MANAGEMENT ===

exports.getBuses = async (req, res) => {
    try {
        const buses = await Bus.find().sort({ licensePlate: 1 });
        res.json({ ok: true, buses });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.createBus = async (req, res) => {
    try {
        const { licensePlate, brand, capacity, status } = req.body;
        if (!licensePlate) return res.status(400).json({ ok: false, message: 'Biển số xe là bắt buộc' });
        const exists = await Bus.findOne({ licensePlate });
        if (exists) return res.status(400).json({ ok: false, message: 'Biển số xe đã tồn tại' });
        const newBus = await Bus.create({ licensePlate, brand, capacity: capacity || 45, status: status || 'READY' });
        res.json({ ok: true, message: 'Tạo xe thành công', bus: newBus });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.updateBus = async (req, res) => {
    try {
        const { id } = req.params;
        const { licensePlate, brand, capacity, status } = req.body;
        const bus = await Bus.findByIdAndUpdate(id, { licensePlate, brand, capacity, status }, { new: true });
        if (!bus) return res.status(404).json({ ok: false, message: 'Không tìm thấy xe' });
        res.json({ ok: true, message: 'Cập nhật xe thành công', bus });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

// === SCHEDULE MANAGEMENT ===

exports.getSchedules = async (req, res) => {
    try {
        const schedules = await Schedule.find()
            .populate('driverId', 'fullName phone email avatar')
            .populate('conductorId', 'fullName phone email avatar')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name')
            .sort({ date: -1, 'shiftTime.start': 1 });
        res.json({ ok: true, schedules });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.createSchedule = async (req, res) => {
    try {
        const { driverId, conductorId, busId, routeId, date, shiftStart, shiftEnd } = req.body;
        if (!routeId || !date) return res.status(400).json({ ok: false, message: 'Tuyến và ngày là bắt buộc' });

        const newSchedule = await Schedule.create({
            driverId: driverId || null,
            conductorId: conductorId || null,
            busId: busId || null,
            routeId, date,
            shiftTime: { start: shiftStart, end: shiftEnd }
        });

        const populated = await Schedule.findById(newSchedule._id)
            .populate('driverId', 'fullName phone email avatar')
            .populate('conductorId', 'fullName phone email avatar')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name');

        res.json({ ok: true, message: 'Tạo lịch thành công', schedule: populated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.updateSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        const { driverId, conductorId, busId, routeId, date, shiftStart, shiftEnd } = req.body;

        const updated = await Schedule.findByIdAndUpdate(id, {
            driverId: driverId || null,
            conductorId: conductorId || null,
            busId: busId || null,
            routeId, date,
            shiftTime: { start: shiftStart, end: shiftEnd }
        }, { new: true })
            .populate('driverId', 'fullName phone email avatar')
            .populate('conductorId', 'fullName phone email avatar')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name');

        if (!updated) return res.status(404).json({ ok: false, message: 'Không tìm thấy lịch' });
        res.json({ ok: true, message: 'Cập nhật thành công', schedule: updated });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.deleteSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        await Schedule.findByIdAndDelete(id);
        res.json({ ok: true, message: 'Xóa lịch thành công' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

// PATCH /api/admin/schedules/:id/log  — cập nhật nhật ký sau chuyến
exports.updateTripLog = async (req, res) => {
    try {
        const { id } = req.params;
        const { actualStart, actualEnd, passengerCount, revenue, notes } = req.body;
        const updated = await Schedule.findByIdAndUpdate(id, {
            actualStart, actualEnd,
            passengerCount: Number(passengerCount) || 0,
            revenue: Number(revenue) || 0,
            notes
        }, { new: true })
            .populate('driverId', 'fullName')
            .populate('busId', 'licensePlate capacity')
            .populate('routeId', 'routeNumber name');
        if (!updated) return res.status(404).json({ ok: false, message: 'Không tìm thấy chuyến xe' });
        res.json({ ok: true, message: 'Đã cập nhật nhật ký chuyến', schedule: updated });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};
