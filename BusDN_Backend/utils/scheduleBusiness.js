/**
 * Logic nghiệp vụ lịch chuyến (tần suất, slot, chồng lấn, giờ làm)
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
    if (!hhmm || !TIME_RE.test(String(hhmm).trim())) return null;
    const [h, m] = String(hhmm).trim().split(':').map(Number);
    return h * 60 + m;
}

function toHHMM(total) {
    const h = Math.floor(total / 60) % 24;
    const m = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Mỗi ngày trong [from, to] (YYYY-MM-DD) */
function eachDateISO(fromStr, toStr) {
    const out = [];
    const a = new Date(fromStr + 'T12:00:00');
    const b = new Date(toStr + 'T12:00:00');
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) return out;
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}

/**
 * Sinh giờ xuất bến: mỗi frequency phút, sao cho dep + roundTrip <= min(operationEnd, lastReturnCap)
 */
function generateDepartureSlots({
    opStart,
    opEnd,
    frequencyMinutes,
    roundTripMinutes,
    bufferMinutes,
    lastReturnCap = '19:30',
}) {
    const freq = Math.max(1, Number(frequencyMinutes) || 15);
    const rt = Math.max(1, Number(roundTripMinutes) || 60);
    const buf = Math.max(0, Number(bufferMinutes) || 0);
    const slotBlock = rt + buf;

    const startM = toMinutes(opStart);
    const endOpM = toMinutes(opEnd);
    const capM = toMinutes(lastReturnCap);
    if (startM == null || endOpM == null || capM == null) return [];

    const lastDepartureLatest = Math.min(endOpM, capM) - rt;
    if (lastDepartureLatest < startM) return [];

    const slots = [];
    for (let t = startM; t <= lastDepartureLatest; t += freq) {
        slots.push(toHHMM(t));
    }
    return slots;
}

/** Hai khoảng [a,a+durA) và [b,b+durB) có chồng lấn (cùng ngày) */
function rangesOverlapMin(aStart, aDur, bStart, bDur) {
    const aEnd = aStart + aDur;
    const bEnd = bStart + bDur;
    return aStart < bEnd && bStart < aEnd;
}

/** Ước lượng phút làm việc trong ngày của tài xế từ danh sách lịch (cùng driver, cùng date ISO) */
function driverDayMinutes(schedules, driverId, dateISO, excludeId) {
    const idStr = driverId?.toString?.();
    if (!idStr) return 0;
    let total = 0;
    for (const s of schedules) {
        if (excludeId && String(s._id) === String(excludeId)) continue;
        if (!s.driverId || s.driverId.toString() !== idStr) continue;
        const d = s.date ? new Date(s.date).toISOString().slice(0, 10) : '';
        if (d !== dateISO) continue;
        const dur = scheduleBlockMinutes(s);
        total += dur;
    }
    return total;
}

function scheduleBlockMinutes(s) {
    if (s.slotDurationMinutes != null && Number(s.slotDurationMinutes) > 0) {
        return Number(s.slotDurationMinutes);
    }
    if (s.departureTime && s.shiftTime?.end) {
        const a = toMinutes(s.departureTime);
        const b = toMinutes(s.shiftTime.end);
        if (a != null && b != null && b > a) return b - a;
    }
    if (s.shiftTime?.start && s.shiftTime?.end) {
        const a = toMinutes(s.shiftTime.start);
        const b = toMinutes(s.shiftTime.end);
        if (a != null && b != null && b > a) return b - a;
    }
    return 8 * 60;
}

function scheduleStartMinutes(s) {
    if (s.departureTime) {
        const m = toMinutes(s.departureTime);
        if (m != null) return m;
    }
    if (s.shiftTime?.start) return toMinutes(s.shiftTime.start);
    return 0;
}

const MAX_DRIVER_MIN_PER_DAY = 8 * 60;
const LOCK_EDIT_MINUTES_BEFORE = 10;

/** Giờ xuất bến có nằm trên lưới tần suất (phút) kể từ mốc mở bến không */
function departureAlignsGrid(depHHMM, opStartHHMM, frequencyMinutes) {
    const freq = Math.max(1, Number(frequencyMinutes) || 15);
    const d = toMinutes(depHHMM);
    const o = toMinutes(opStartHHMM);
    if (d == null || o == null) return true;
    const diff = d - o;
    if (diff < 0) return false;
    return diff % freq === 0;
}

module.exports = {
    toMinutes,
    toHHMM,
    eachDateISO,
    generateDepartureSlots,
    rangesOverlapMin,
    driverDayMinutes,
    scheduleBlockMinutes,
    scheduleStartMinutes,
    departureAlignsGrid,
    MAX_DRIVER_MIN_PER_DAY,
    LOCK_EDIT_MINUTES_BEFORE,
};
