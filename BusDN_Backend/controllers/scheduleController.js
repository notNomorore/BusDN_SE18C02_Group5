const { Schedule, Bus, Route, User, MonthlyPass, TripTicket } = require('../models/models');
const { getIO } = require('../config/socket');
const sb = require('../utils/scheduleBusiness');

function emitScheduleChange(action, scheduleDoc) {
    const io = getIO();
    if (!io) return;
    const payload = {
        action,
        scheduleId: String(scheduleDoc._id),
        routeId: String(scheduleDoc.routeId?._id || scheduleDoc.routeId),
        date: scheduleDoc.date,
        status: scheduleDoc.status,
        departureTime: scheduleDoc.departureTime || null,
    };
    io.to('role:DRIVER').emit('schedule:changed', payload);
    io.to('role:CONDUCTOR').emit('schedule:changed', payload);
    io.to('admins').emit('schedule:changed', payload);
    const dId = scheduleDoc.driverId?._id || scheduleDoc.driverId;
    const cId = scheduleDoc.conductorId?._id || scheduleDoc.conductorId;
    if (dId) io.to(`user:${dId}`).emit('schedule:changed', payload);
    if (cId) io.to(`user:${cId}`).emit('schedule:changed', payload);
}

async function getBookedTripTicketUserIds(scheduleId) {
    const rows = await TripTicket.find({ scheduleId, status: 'BOOKED' }).select('userId').lean();
    return [...new Set(rows.map((r) => String(r.userId)))];
}

async function notifyPassengersTripTicketSocket(scheduleId, { title, message }) {
    const io = getIO();
    if (!io) return;
    const userIds = await getBookedTripTicketUserIds(scheduleId);
    const payload = {
        title,
        message,
        kind: 'TRIP_SCHEDULE',
        scheduleId: String(scheduleId),
    };
    for (const uid of userIds) {
        io.to(`user:${uid}`).emit('notification:new', payload);
    }
}

function computeFrequencyGapRisk(removedSchedule, route, allDayDocs) {
    if (!route?.frequencyMinutes) return false;
    const freq = Math.max(1, Number(route.frequencyMinutes) || 15);
    const rid = String(
        removedSchedule.routeId?._id ?? removedSchedule.routeId
    );
    const rDep = sb.scheduleStartMinutes(removedSchedule);
    if (rDep == null) return false;
    const tol = 3;
    const siblings = allDayDocs.filter(
        (x) =>
            String(x.routeId?._id ?? x.routeId) === rid &&
            !x.archived &&
            x.status !== 'CANCELLED' &&
            String(x._id) !== String(removedSchedule._id)
    );
    const deps = siblings
        .map((s) => sb.scheduleStartMinutes(s))
        .filter((m) => m != null)
        .sort((a, b) => a - b);
    let prev = null;
    let next = null;
    for (let i = deps.length - 1; i >= 0; i--) {
        if (deps[i] < rDep) {
            prev = deps[i];
            break;
        }
    }
    for (let i = 0; i < deps.length; i++) {
        if (deps[i] > rDep) {
            next = deps[i];
            break;
        }
    }
    if (prev == null || next == null) return false;
    const gapPrev = rDep - prev;
    const gapNext = next - rDep;
    if (Math.abs(gapPrev - freq) > tol || Math.abs(gapNext - freq) > tol) return false;
    const newGap = next - prev;
    return Math.abs(newGap - 2 * freq) <= tol + 2;
}

async function scheduleNoticePayload(action, scheduleDoc) {
    const rid = scheduleDoc.routeId?._id || scheduleDoc.routeId;
    let routeNumber = scheduleDoc.routeId?.routeNumber;
    if (!routeNumber && rid) {
        const r = await Route.findById(rid).select('routeNumber').lean();
        routeNumber = r?.routeNumber;
    }
    const dep = scheduleDoc.departureTime || scheduleDoc.shiftTime?.start || '';
    const rn = routeNumber ? `Tuyến ${routeNumber}` : 'Chuyến xe';
    if (action === 'deleted') {
        return {
            title: 'Chuyến đã bị gỡ lịch',
            message: `${rn}${dep ? ` — xuất bến ${dep}` : ''} không còn trên lịch. Nếu bạn có vé lẻ, vui lòng kiểm tra mục Vé lẻ / ví hoặc liên hệ CSKH.`,
        };
    }
    if (action === 'cancelled') {
        return {
            title: 'Chuyến bị hủy',
            message: `${rn}${dep ? ` (${dep})` : ''} đã hủy. Vé lẻ đã mua có thể cần xử lý lại — kiểm tra thông báo và ví.`,
        };
    }
    if (action === 'updated') {
        return {
            title: 'Lịch chuyến thay đổi',
            message: `${rn}${dep ? ` — giờ xuất bến ${dep}` : ''} đã được cập nhật. Vui lòng xem lại thông tin chuyến trong ứng dụng.`,
        };
    }
    return null;
}

async function emitScheduleChangeAndNotifyPassengers(action, scheduleDoc) {
    emitScheduleChange(action, scheduleDoc);
    const sid = scheduleDoc._id;
    if (!sid || !['deleted', 'cancelled', 'updated'].includes(action)) return;
    const payload = await scheduleNoticePayload(action, scheduleDoc);
    if (payload) await notifyPassengersTripTicketSocket(sid, payload);
}

function dateISO(d) {
    return new Date(d).toISOString().slice(0, 10);
}

function dayBounds(dateInput) {
    const start = new Date(dateInput);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateInput);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

function coerceStatus(s) {
    if (s.status && ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(s.status)) {
        return s.status;
    }
    const today = new Date().toISOString().slice(0, 10);
    const ds = dateISO(s.date);
    if (ds < today) return 'COMPLETED';
    return 'SCHEDULED';
}

function combinedDateTime(dateVal, hhmm) {
    const d = new Date(dateVal);
    const parts = String(hhmm || '00:00').split(':');
    const H = parseInt(parts[0], 10) || 0;
    const M = parseInt(parts[1], 10) || 0;
    d.setHours(H, M, 0, 0);
    return d;
}

function normalizeScheduleForValidation(doc) {
    const slotDur = doc.slotDurationMinutes != null && Number(doc.slotDurationMinutes) > 0
        ? Number(doc.slotDurationMinutes)
        : sb.scheduleBlockMinutes(doc);
    return {
        _id: doc._id,
        date: doc.date,
        busId: doc.busId?._id || doc.busId,
        driverId: doc.driverId?._id || doc.driverId,
        conductorId: doc.conductorId?._id || doc.conductorId,
        departureTime: doc.departureTime,
        shiftTime: doc.shiftTime,
        slotDurationMinutes: slotDur,
    };
}

function classifyUpdateLevel(existing, candidate) {
    const oldStart = sb.scheduleStartMinutes(existing);
    const newStart = sb.scheduleStartMinutes(candidate);
    const startDiff = Math.abs((newStart ?? 0) - (oldStart ?? 0));
    const changedRoute = String(existing.routeId) !== String(candidate.routeId);
    const changedDate = dateISO(existing.date) !== dateISO(candidate.date);
    const changedTime = (existing.departureTime || '') !== (candidate.departureTime || '') || startDiff > 0;
    const changedOps = changedRoute || changedDate || startDiff > 30;
    if (changedOps) return 'DANGER';
    if (changedTime || String(existing.shiftTime?.end || '') !== String(candidate.shiftTime?.end || '')) return 'MEDIUM';
    return 'SAFE';
}

async function computeUpdateImpact(existing, candidate) {
    const level = classifyUpdateLevel(existing, candidate);
    const oldDay = dayBounds(existing.date);
    const daily = await Schedule.find({
        date: { $gte: oldDay.start, $lte: oldDay.end },
        archived: { $ne: true },
        status: { $ne: 'CANCELLED' },
    }).lean();
    const impactedTrips = daily.filter((s) => {
        if (String(s._id) === String(existing._id)) return true;
        const sStart = sb.scheduleStartMinutes(s);
        const sDur = sb.scheduleBlockMinutes(s);
        const oldStart = sb.scheduleStartMinutes(existing);
        const oldDur = sb.scheduleBlockMinutes(existing);
        const newStart = sb.scheduleStartMinutes(candidate);
        const newDur = sb.scheduleBlockMinutes(candidate);
        const overlapOld = sb.rangesOverlapMin(sStart, sDur, oldStart, oldDur);
        const overlapNew = sb.rangesOverlapMin(sStart, sDur, newStart, newDur);
        return overlapOld || overlapNew;
    });
    const driverSet = new Set(impactedTrips.map((s) => String(s.driverId || '')).filter(Boolean));
    const passengerCount = await TripTicket.countDocuments({
        scheduleId: { $in: impactedTrips.map((x) => x._id) },
        status: { $in: ['BOOKED', 'USED'] },
    });
    return {
        level,
        impactedTrips: impactedTrips.length,
        impactedDrivers: driverSet.size,
        impactedPassengers: passengerCount,
    };
}

/**
 * @returns {{ errors: string[], warnings: string[] }}
 */
async function validateScheduleAssignments(candidate, route, allDayDocs) {
    const errors = [];
    const warnings = [];
    const cand = normalizeScheduleForValidation(candidate);
    const dateStr = dateISO(cand.date);
    const candStart = sb.scheduleStartMinutes(cand);
    const candDur = cand.slotDurationMinutes || sb.scheduleBlockMinutes(cand);

    if (route && route.status !== 'ACTIVE') {
        errors.push('Tuyến không hợp lệ hoặc đã ngưng hoạt động');
    }

    if (cand.departureTime && route?.frequencyMinutes && route?.operationTime?.start) {
        if (!sb.departureAlignsGrid(cand.departureTime, route.operationTime.start, route.frequencyMinutes)) {
            errors.push(
                `Giờ xuất bến phải khớp lưới ${route.frequencyMinutes} phút từ ${route.operationTime.start} (ví dụ cách đều theo tần suất tuyến)`
            );
        }
    }

    if (cand.busId) {
        const bus = await Bus.findById(cand.busId).lean();
        if (!bus) errors.push('Không tìm thấy xe');
        else if (bus.status === 'MAINTENANCE') errors.push('Xe đang bảo dưỡng, không thể xếp lịch');
    }

    if (cand.driverId) {
        const u = await User.findById(cand.driverId).lean();
        if (!u || u.role !== 'DRIVER') errors.push('Tài xế không hợp lệ');
    }
    if (cand.conductorId) {
        const u = await User.findById(cand.conductorId).lean();
        if (!u || u.role !== 'CONDUCTOR') errors.push('Phụ xe không hợp lệ');
    }

    const others = allDayDocs.filter((x) => String(x._id) !== String(cand._id));

    for (const o of others) {
        const oNorm = normalizeScheduleForValidation(o);
        const oStatus = coerceStatus(o);
        if (oStatus === 'CANCELLED' || o.archived) continue;

        const oStart = sb.scheduleStartMinutes(oNorm);
        const oDur = oNorm.slotDurationMinutes || sb.scheduleBlockMinutes(oNorm);

        if (cand.busId && oNorm.busId && String(cand.busId) === String(oNorm.busId)) {
            if (sb.rangesOverlapMin(candStart, candDur, oStart, oDur)) {
                errors.push('Xe bị trùng lịch trong cùng ngày');
                break;
            }
        }
        if (cand.driverId && oNorm.driverId && String(cand.driverId) === String(oNorm.driverId)) {
            if (sb.rangesOverlapMin(candStart, candDur, oStart, oDur)) {
                errors.push('Tài xế bị trùng lịch trong cùng ngày');
                break;
            }
        }
        if (cand.conductorId && oNorm.conductorId && String(cand.conductorId) === String(oNorm.conductorId)) {
            if (sb.rangesOverlapMin(candStart, candDur, oStart, oDur)) {
                errors.push('Phụ xe bị trùng lịch trong cùng ngày');
                break;
            }
        }
    }

    if (cand.driverId) {
        const list = [...others, cand].map((x) => (String(x._id) === String(cand._id) ? candidate : x));
        const minutes = sb.driverDayMinutes(list, cand.driverId, dateStr, null);
        if (minutes > sb.MAX_DRIVER_MIN_PER_DAY) {
            errors.push(`Tài xế vượt quá ${sb.MAX_DRIVER_MIN_PER_DAY / 60} giờ làm trong ngày`);
        }
    }

    if (!cand.busId || !cand.driverId) {
        warnings.push('Thiếu xe hoặc tài xế — nên bổ sung trước khi chạy');
    }

    return { errors, warnings };
}

async function loadSchedulesForDay(dateInput, excludeId) {
    const { start, end } = dayBounds(dateInput);
    const q = {
        date: { $gte: start, $lte: end },
        archived: { $ne: true },
    };
    const list = await Schedule.find(q).lean();
    return excludeId ? list.filter((x) => String(x._id) !== String(excludeId)) : list;
}

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
        const schedules = await Schedule.find({ archived: { $ne: true } })
            .populate('driverId', 'fullName phone email avatar')
            .populate('conductorId', 'fullName phone email avatar')
            .populate('busId', 'licensePlate brand capacity status')
            .populate('routeId', 'routeNumber name frequencyMinutes roundTripMinutes bufferMinutes')
            .sort({ date: -1, departureTime: 1, 'shiftTime.start': 1 });

        const enriched = schedules.map((s) => {
            const o = s.toObject();
            o.effectiveStatus = coerceStatus(o);
            return o;
        });

        res.json({ ok: true, schedules: enriched });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.getDeleteImpact = async (req, res) => {
    try {
        const s = await Schedule.findById(req.params.id)
            .populate('driverId', 'fullName')
            .populate('routeId', 'routeNumber name frequencyMinutes operationTime');
        if (!s) return res.status(404).json({ ok: false, message: 'Không tìm thấy lịch' });

        const st = coerceStatus(s);
        const { start, end } = dayBounds(s.date);
        const monthlyPassCount = await MonthlyPass.countDocuments({
            routeId: s.routeId._id || s.routeId,
            status: 'ACTIVE',
            validFrom: { $lte: end },
            validTo: { $gte: start },
        });
        const tripTicketsBooked = await TripTicket.countDocuments({
            scheduleId: s._id,
            status: 'BOOKED',
        });
        const tripTicketsAll = await TripTicket.countDocuments({
            scheduleId: s._id,
            status: { $in: ['BOOKED', 'USED'] },
        });

        const dayDocs = await loadSchedulesForDay(s.date, null);
        const routeLean =
            s.routeId && typeof s.routeId === 'object' && s.routeId.frequencyMinutes != null
                ? s.routeId
                : await Route.findById(s.routeId._id || s.routeId).lean();
        const frequencyGapRisk =
            st === 'SCHEDULED' && routeLean ? computeFrequencyGapRisk(s, routeLean, dayDocs) : false;

        res.json({
            ok: true,
            impact: {
                status: st,
                departureTime: s.departureTime,
                shiftTime: s.shiftTime,
                driverName: s.driverId?.fullName || null,
                routeNumber: s.routeId?.routeNumber,
                activeMonthlyPassesOnDay: monthlyPassCount,
                activeTripTicketsBooked: tripTicketsBooked,
                activeTripTickets: tripTicketsAll,
                frequencyGapRisk,
            },
        });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.getUpdateImpact = async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await Schedule.findById(id).lean();
        if (!existing) return res.status(404).json({ ok: false, message: 'Không tìm thấy lịch' });

        const candidate = {
            ...existing,
            routeId: req.body.routeId || existing.routeId,
            date: req.body.date ? new Date(req.body.date) : existing.date,
            departureTime: req.body.departureTime !== undefined ? req.body.departureTime : existing.departureTime,
            shiftTime: {
                start: req.body.shiftStart || existing.shiftTime?.start,
                end: req.body.shiftEnd || existing.shiftTime?.end,
            },
            driverId: req.body.driverId !== undefined ? req.body.driverId || null : existing.driverId,
            conductorId: req.body.conductorId !== undefined ? req.body.conductorId || null : existing.conductorId,
            busId: req.body.busId !== undefined ? req.body.busId || null : existing.busId,
            slotDurationMinutes: req.body.slotDurationMinutes != null ? Number(req.body.slotDurationMinutes) : existing.slotDurationMinutes,
        };
        if (!candidate.slotDurationMinutes) candidate.slotDurationMinutes = sb.scheduleBlockMinutes(candidate);
        const impact = await computeUpdateImpact(existing, candidate);
        return res.json({ ok: true, impact });
    } catch (err) {
        return res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.createSchedule = async (req, res) => {
    try {
        const {
            driverId, conductorId, busId, routeId, date,
            shiftStart, shiftEnd, departureTime, slotDurationMinutes: bodySlotDur,
            dryRun,
        } = req.body;

        const normalizedShiftStart = shiftStart || req.body.startTime;
        const normalizedShiftEnd = shiftEnd || req.body.endTime;

        if (!routeId || !date) return res.status(400).json({ ok: false, message: 'Tuyến và ngày là bắt buộc' });
        if (!normalizedShiftStart || !normalizedShiftEnd) return res.status(400).json({ ok: false, message: 'Ca làm (bắt đầu / kết thúc) là bắt buộc' });

        const route = await Route.findById(routeId).lean();
        if (!route) return res.status(404).json({ ok: false, message: 'Không tìm thấy tuyến' });

        // Giới hạn ca kết thúc: xe phải về muộn nhất trước 19:30
        const CAP_END = '19:30';
        const capM = sb.toMinutes(CAP_END);
        const endM = sb.toMinutes(normalizedShiftEnd);
        if (capM != null && endM != null && endM > capM) {
            return res.status(400).json({
                ok: false,
                message: `Giờ kết thúc ca không được vượt quá ${CAP_END}.`,
            });
        }

        const rt = Number(route.roundTripMinutes) || 60;
        const buf = Number(route.bufferMinutes) || 10;
        const slotDur = bodySlotDur != null && Number(bodySlotDur) > 0
            ? Number(bodySlotDur)
            : (departureTime ? rt + buf : null);

        const dayList = await loadSchedulesForDay(date, null);

        const candidate = {
            _id: 'new',
            date: new Date(date),
            busId: busId || null,
            driverId: driverId || null,
            conductorId: conductorId || null,
            departureTime: departureTime || null,
            slotDurationMinutes: slotDur,
            shiftTime: { start: normalizedShiftStart, end: normalizedShiftEnd },
        };

        if (!candidate.slotDurationMinutes) {
            const a = sb.toMinutes(shiftStart);
            const b = sb.toMinutes(shiftEnd);
            candidate.slotDurationMinutes = a != null && b != null && b > a ? b - a : rt + buf;
        }

        const { errors, warnings } = await validateScheduleAssignments(candidate, route, dayList);
        if (errors.length) {
            return res.status(400).json({ ok: false, message: errors[0], errors, warnings });
        }
        if (dryRun) {
            return res.json({ ok: true, dryRun: true, warnings, message: 'Kiểm tra hợp lệ' });
        }

        const newSchedule = await Schedule.create({
            driverId: driverId || null,
            conductorId: conductorId || null,
            busId: busId || null,
            routeId,
            date: new Date(date),
            departureTime: departureTime || null,
            slotDurationMinutes: candidate.slotDurationMinutes,
            shiftTime: { start: shiftStart, end: shiftEnd },
            status: 'SCHEDULED',
            archived: false,
        });

        const populated = await Schedule.findById(newSchedule._id)
            .populate('driverId', 'fullName phone email avatar')
            .populate('conductorId', 'fullName phone email avatar')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name');

        emitScheduleChange('created', populated);
        res.json({ ok: true, message: 'Tạo lịch thành công', schedule: populated, warnings });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.updateSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            driverId, conductorId, busId, routeId, date,
            shiftStart, shiftEnd, departureTime, slotDurationMinutes: bodySlotDur,
            dryRun,
        } = req.body;

        const existing = await Schedule.findById(id);
        if (!existing) return res.status(404).json({ ok: false, message: 'Không tìm thấy lịch' });

        const st = coerceStatus(existing);
        if (st === 'COMPLETED') {
            return res.status(400).json({ ok: false, message: 'Không được sửa chuyến đã hoàn thành (chỉ xem / lưu trữ)' });
        }
        if (st === 'CANCELLED') {
            return res.status(400).json({ ok: false, message: 'Chuyến đã hủy, không sửa được' });
        }

        const normalizedShiftStart = shiftStart || req.body.startTime;
        const normalizedShiftEnd = shiftEnd || req.body.endTime;

        const dep = departureTime !== undefined ? departureTime : existing.departureTime;
        const startStr = normalizedShiftStart || existing.shiftTime?.start;
        const tripStart = combinedDateTime(existing.date, dep || startStr);
        const now = new Date();
        const minsUntil = (tripStart - now) / 60000;
        if (st === 'SCHEDULED' && minsUntil <= sb.LOCK_EDIT_MINUTES_BEFORE && minsUntil > -120) {
            return res.status(400).json({
                ok: false,
                message: `Chuyến sắp chạy (≤ ${sb.LOCK_EDIT_MINUTES_BEFORE} phút), không cho sửa tùy tiện`,
            });
        }

        const route = await Route.findById(routeId || existing.routeId).lean();
        if (!route) return res.status(404).json({ ok: false, message: 'Không tìm thấy tuyến' });

        const rt = Number(route.roundTripMinutes) || 60;
        const buf = Number(route.bufferMinutes) || 10;
        let slotDur = bodySlotDur != null && Number(bodySlotDur) > 0 ? Number(bodySlotDur) : existing.slotDurationMinutes;
        if (!slotDur) {
            slotDur = dep ? rt + buf : null;
        }
        if (!slotDur) {
            const a = sb.toMinutes(shiftStart || existing.shiftTime?.start);
            const b = sb.toMinutes(shiftEnd || existing.shiftTime?.end);
            slotDur = a != null && b != null && b > a ? b - a : rt + buf;
        }

        const candidate = {
            _id: existing._id,
            date: date ? new Date(date) : existing.date,
            busId: busId !== undefined ? busId || null : existing.busId,
            driverId: driverId !== undefined ? driverId || null : existing.driverId,
            conductorId: conductorId !== undefined ? conductorId || null : existing.conductorId,
            departureTime: dep || null,
            slotDurationMinutes: slotDur,
            shiftTime: {
                start: normalizedShiftStart || existing.shiftTime?.start,
                end: normalizedShiftEnd || existing.shiftTime?.end,
            },
        };

        // Giới hạn ca kết thúc: xe phải về muộn nhất trước 19:30
        const CAP_END = '19:30';
        const capM = sb.toMinutes(CAP_END);
        const endM = sb.toMinutes(candidate.shiftTime?.end);
        if (capM != null && endM != null && endM > capM) {
            return res.status(400).json({
                ok: false,
                message: `Giờ kết thúc ca không được vượt quá ${CAP_END}.`,
            });
        }

        const dayList = await loadSchedulesForDay(candidate.date, id);
        const { errors, warnings } = await validateScheduleAssignments(candidate, route, dayList);
        if (errors.length) {
            return res.status(400).json({ ok: false, message: errors[0], errors, warnings });
        }
        if (dryRun) {
            return res.json({ ok: true, dryRun: true, warnings, message: 'Kiểm tra hợp lệ' });
        }

        existing.driverId = candidate.driverId;
        existing.conductorId = candidate.conductorId;
        existing.busId = candidate.busId;
        existing.routeId = routeId || existing.routeId;
        existing.date = candidate.date;
        existing.departureTime = candidate.departureTime;
        existing.slotDurationMinutes = slotDur;
        existing.shiftTime = candidate.shiftTime;
        await existing.save();

        const populated = await Schedule.findById(existing._id)
            .populate('driverId', 'fullName phone email avatar')
            .populate('conductorId', 'fullName phone email avatar')
            .populate('busId', 'licensePlate brand capacity')
            .populate('routeId', 'routeNumber name');

        await emitScheduleChangeAndNotifyPassengers('updated', populated);
        res.json({ ok: true, message: 'Cập nhật thành công', schedule: populated, warnings });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.archiveSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        const s = await Schedule.findById(id);
        if (!s) return res.status(404).json({ ok: false, message: 'Không tìm thấy lịch' });
        if (coerceStatus(s) !== 'COMPLETED') {
            return res.status(400).json({ ok: false, message: 'Chỉ archive chuyến đã hoàn thành' });
        }
        s.archived = true;
        await s.save();
        emitScheduleChange('archived', s);
        res.json({ ok: true, message: 'Đã chuyển vào lưu trữ' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.deleteSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        const acknowledge = req.query.acknowledgeMonthlyPass === '1';
        const acknowledgeTripTickets = req.query.acknowledgeTripTickets === '1';
        const s = await Schedule.findById(id);
        if (!s) return res.status(404).json({ ok: false, message: 'Không tìm thấy lịch' });

        const st = coerceStatus(s);
        if (st === 'COMPLETED') {
            return res.status(400).json({
                ok: false,
                message: 'Không xóa chuyến đã hoàn thành — dùng lưu trữ (archive)',
                code: 'COMPLETED_NO_DELETE',
            });
        }
        if (st === 'IN_PROGRESS') {
            s.status = 'CANCELLED';
            await s.save();
            const populated = await Schedule.findById(s._id)
                .populate('driverId', 'fullName')
                .populate('routeId', 'routeNumber');
            await emitScheduleChangeAndNotifyPassengers('cancelled', populated);
            return res.json({ ok: true, message: 'Chuyến đang chạy đã được hủy (cancel) và thông báo realtime', schedule: populated });
        }

        const { start, end } = dayBounds(s.date);
        const monthlyPassCount = await MonthlyPass.countDocuments({
            routeId: s.routeId,
            status: 'ACTIVE',
            validFrom: { $lte: end },
            validTo: { $gte: start },
        });
        if (monthlyPassCount > 0 && !acknowledge) {
            return res.status(409).json({
                ok: false,
                message: `Có ${monthlyPassCount} vé tháng còn hiệu lực cho tuyến này trong ngày — xác nhận trước khi xóa`,
                code: 'MONTHLY_PASS_WARNING',
                activeMonthlyPassesOnDay: monthlyPassCount,
            });
        }

        const bookedTripCount = await TripTicket.countDocuments({ scheduleId: s._id, status: 'BOOKED' });
        if (bookedTripCount > 0 && !acknowledgeTripTickets) {
            return res.status(409).json({
                ok: false,
                message: `Có ${bookedTripCount} vé lẻ đã đặt cho chuyến này — xác nhận trước khi xóa`,
                code: 'TRIP_TICKET_WARNING',
                activeTripTicketsBooked: bookedTripCount,
            });
        }

        const deletedPayload = {
            _id: s._id,
            routeId: s.routeId,
            date: s.date,
            status: 'DELETED',
            driverId: s.driverId,
            conductorId: s.conductorId,
            departureTime: s.departureTime,
            shiftTime: s.shiftTime,
        };
        await emitScheduleChangeAndNotifyPassengers('deleted', deletedPayload);
        await Schedule.findByIdAndDelete(id);
        res.json({ ok: true, message: 'Đã xóa lịch chưa chạy' });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

/**
 * Sinh nhiều chuyến theo tần suất tuyến (doc: bước 1–3)
 * Body: { routeId, dateFrom, dateTo, autoAssign?, replaceScheduled? }
 */
exports.generateSchedules = async (req, res) => {
    try {
        const { routeId, dateFrom, dateTo, autoAssign, replaceScheduled } = req.body;
        if (!routeId || !dateFrom || !dateTo) {
            return res.status(400).json({ ok: false, message: 'Thiếu routeId, dateFrom hoặc dateTo' });
        }

        const route = await Route.findById(routeId).lean();
        if (!route || route.status !== 'ACTIVE') {
            return res.status(400).json({ ok: false, message: 'Tuyến không hợp lệ' });
        }

        const days = sb.eachDateISO(String(dateFrom).slice(0, 10), String(dateTo).slice(0, 10));
        if (!days.length) return res.status(400).json({ ok: false, message: 'Khoảng ngày không hợp lệ' });

        const opStart = route.operationTime?.start || '05:00';
        const opEnd = route.operationTime?.end || '21:00';
        const freq = route.frequencyMinutes || 15;
        const rt = route.roundTripMinutes || 60;
        const buf = route.bufferMinutes || 10;
        const slotBlock = rt + buf;

        const rangeStart = new Date(days[0]);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(days[days.length - 1]);
        rangeEnd.setHours(23, 59, 59, 999);

        if (replaceScheduled) {
            await Schedule.deleteMany({
                routeId,
                date: { $gte: rangeStart, $lte: rangeEnd },
                status: 'SCHEDULED',
                archived: { $ne: true },
            });
        }

        const buses = await Bus.find({ status: 'READY' }).sort({ licensePlate: 1 }).lean();
        const drivers = await User.find({ role: 'DRIVER', status: 'ACTIVE', isLocked: { $ne: true } }).lean();
        const conductors = await User.find({ role: 'CONDUCTOR', status: 'ACTIVE', isLocked: { $ne: true } }).lean();
        const routeAffinityRows = await Schedule.aggregate([
            { $match: { routeId: route._id, status: { $ne: 'CANCELLED' }, archived: { $ne: true } } },
            { $group: { _id: '$driverId', cnt: { $sum: 1 } } }
        ]);
        const driverRouteAffinity = new Map(routeAffinityRows.map((r) => [String(r._id), Number(r.cnt || 0)]));
        const conductorAffinityRows = await Schedule.aggregate([
            { $match: { routeId: route._id, status: { $ne: 'CANCELLED' }, archived: { $ne: true } } },
            { $group: { _id: '$conductorId', cnt: { $sum: 1 } } }
        ]);
        const conductorRouteAffinity = new Map(conductorAffinityRows.map((r) => [String(r._id), Number(r.cnt || 0)]));

        const assignCount = {
            bus: new Map(),
            driver: new Map(),
            conductor: new Map(),
        };
        const created = [];
        const skipped = [];

        for (const day of days) {
            const slots = sb.generateDepartureSlots({
                opStart,
                opEnd,
                frequencyMinutes: freq,
                roundTripMinutes: rt,
                bufferMinutes: buf,
                lastReturnCap: '19:30',
            });

            let dayList = await loadSchedulesForDay(day, null);

            for (const dep of slots) {
                const endMin = sb.toMinutes(dep) + rt;
                const shiftEnd = sb.toHHMM(endMin);

                const candidate = {
                    _id: 'new',
                    date: new Date(day),
                    routeId,
                    departureTime: dep,
                    slotDurationMinutes: slotBlock,
                    shiftTime: { start: dep, end: shiftEnd },
                    busId: null,
                    driverId: null,
                    conductorId: null,
                };

                if (autoAssign && buses.length) {
                    const sortedBuses = [...buses].sort((a, b) =>
                        (assignCount.bus.get(String(a._id)) || 0) - (assignCount.bus.get(String(b._id)) || 0)
                    );
                    for (const b of sortedBuses) {
                        candidate.busId = b._id;
                        const { errors } = await validateScheduleAssignments(candidate, route, dayList);
                        if (!errors.length) break;
                        candidate.busId = null;
                    }
                }

                if (autoAssign && drivers.length && candidate.busId) {
                    const sortedDrivers = [...drivers].sort((a, b) =>
                        ((assignCount.driver.get(String(a._id)) || 0) - (assignCount.driver.get(String(b._id)) || 0)) ||
                        ((driverRouteAffinity.get(String(b._id)) || 0) - (driverRouteAffinity.get(String(a._id)) || 0))
                    );
                    for (const d of sortedDrivers) {
                        candidate.driverId = d._id;
                        const { errors } = await validateScheduleAssignments(candidate, route, dayList);
                        if (!errors.length) break;
                        candidate.driverId = null;
                    }
                }

                if (autoAssign && conductors.length && candidate.busId) {
                    const sortedConductors = [...conductors].sort((a, b) =>
                        ((assignCount.conductor.get(String(a._id)) || 0) - (assignCount.conductor.get(String(b._id)) || 0)) ||
                        ((conductorRouteAffinity.get(String(b._id)) || 0) - (conductorRouteAffinity.get(String(a._id)) || 0))
                    );
                    for (const c of sortedConductors) {
                        candidate.conductorId = c._id;
                        const { errors } = await validateScheduleAssignments(candidate, route, dayList);
                        if (!errors.length) break;
                        candidate.conductorId = null;
                    }
                }

                const { errors, warnings } = await validateScheduleAssignments(candidate, route, dayList);
                if (errors.length) {
                    skipped.push({ day, departureTime: dep, reason: errors[0] });
                    continue;
                }

                const doc = await Schedule.create({
                    routeId,
                    date: new Date(day),
                    departureTime: dep,
                    slotDurationMinutes: slotBlock,
                    shiftTime: { start: dep, end: shiftEnd },
                    busId: candidate.busId,
                    driverId: candidate.driverId,
                    conductorId: candidate.conductorId,
                    status: 'SCHEDULED',
                    archived: false,
                });

                dayList.push(doc.toObject());
                created.push(doc._id);
                if (candidate.busId) assignCount.bus.set(String(candidate.busId), (assignCount.bus.get(String(candidate.busId)) || 0) + 1);
                if (candidate.driverId) assignCount.driver.set(String(candidate.driverId), (assignCount.driver.get(String(candidate.driverId)) || 0) + 1);
                if (candidate.conductorId) assignCount.conductor.set(String(candidate.conductorId), (assignCount.conductor.get(String(candidate.conductorId)) || 0) + 1);
                emitScheduleChange('created', doc);
            }
        }

        res.json({
            ok: true,
            message: `Đã tạo ${created.length} chuyến, bỏ qua ${skipped.length} slot (trùng lịch / thiếu tài nguyên)`,
            createdCount: created.length,
            skipped,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.startTrip = async (req, res) => {
    try {
        const { scheduleId } = req.body;
        if (!scheduleId) return res.status(400).json({ ok: false, message: 'Thiếu scheduleId' });
        const s = await Schedule.findById(scheduleId);
        if (!s) return res.status(404).json({ ok: false, message: 'Không tìm thấy chuyến' });
        if (s.status === 'COMPLETED' || s.status === 'CANCELLED') {
            return res.status(400).json({ ok: false, message: 'Chuyến đã kết thúc hoặc hủy' });
        }
        const isDriver = s.driverId && String(s.driverId) === String(req.user.userId);
        const isConductor = s.conductorId && String(s.conductorId) === String(req.user.userId);
        if (!isDriver && !isConductor) return res.status(403).json({ ok: false, message: 'Không có quyền bắt đầu chuyến này' });
        if (!s.actualStart) {
            s.actualStart = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        }
        s.status = 'IN_PROGRESS';
        await s.save();
        emitScheduleChange('in_progress', s);
        return res.json({ ok: true, message: 'Đã bắt đầu chuyến', schedule: s });
    } catch (err) {
        return res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};

exports.updateTripLog = async (req, res) => {
    try {
        const { id } = req.params;
        const { actualStart, actualEnd, passengerCount, revenue, notes } = req.body;
        const updated = await Schedule.findByIdAndUpdate(id, {
            actualStart, actualEnd,
            passengerCount: Number(passengerCount) || 0,
            revenue: Number(revenue) || 0,
            notes,
            status: 'COMPLETED',
        }, { new: true })
            .populate('driverId', 'fullName')
            .populate('busId', 'licensePlate capacity')
            .populate('routeId', 'routeNumber name');
        if (!updated) return res.status(404).json({ ok: false, message: 'Không tìm thấy chuyến xe' });
        emitScheduleChange('completed', updated);
        res.json({ ok: true, message: 'Đã cập nhật nhật ký chuyến', schedule: updated });
    } catch (err) {
        res.status(500).json({ ok: false, message: 'Lỗi server' });
    }
};
