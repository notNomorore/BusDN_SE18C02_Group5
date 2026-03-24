const { Schedule } = require('../models/models');
const { renderAdmin } = require('../middleware/renderAdmin');

function buildRevenueReportRows(schedules, group) {
    let totalRevenue = 0;
    let totalPassengers = 0;

    schedules.forEach((schedule) => {
        totalRevenue += Number(schedule.revenue || 0);
        totalPassengers += Number(schedule.passengerCount || 0);
    });

    const summary = {
        totalRevenue,
        totalPassengers,
        totalTrips: schedules.length
    };

    const bucketMap = new Map();
    schedules.forEach((schedule) => {
        const revenue = Number(schedule.revenue || 0);
        const passengers = Number(schedule.passengerCount || 0);

        let key = 'unknown';
        let label = 'Không xác định';
        if (group === 'route') {
            key = String(schedule.routeId?._id || 'unknown');
            const routeNumber = schedule.routeId?.routeNumber || '?';
            const routeName = schedule.routeId?.name || 'Tuyến không xác định';
            label = `Tuyến ${routeNumber} - ${routeName}`;
        } else {
            const date = schedule.date ? new Date(schedule.date) : null;
            key = date ? date.toISOString().slice(0, 10) : 'unknown';
            label = date
                ? date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
                : 'Không rõ ngày';
        }

        if (!bucketMap.has(key)) {
            bucketMap.set(key, { key, label, revenue: 0, passengers: 0, trips: 0 });
        }

        const bucket = bucketMap.get(key);
        bucket.revenue += revenue;
        bucket.passengers += passengers;
        bucket.trips += 1;
    });

    const rows = Array.from(bucketMap.values()).sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'vi'));
    return { summary, rows };
}

exports.getReportsPage = (req, res) => {
    return renderAdmin(req, res, 'admin/reports', 'Báo cáo doanh thu', { path: 'reports' });
};

exports.getRevenueReportData = async (req, res) => {
    try {
        const { from, to, group = 'day' } = req.query;
        const filter = {};

        if (from || to) {
            filter.date = {};
            if (from) filter.date.$gte = new Date(from);
            if (to) {
                const endDate = new Date(to);
                endDate.setHours(23, 59, 59, 999);
                filter.date.$lte = endDate;
            }
        }

        const schedules = await Schedule.find(filter)
            .populate('routeId', 'routeNumber name')
            .lean();

        const { summary, rows } = buildRevenueReportRows(schedules, group === 'route' ? 'route' : 'day');
        return res.json({ ok: true, summary, rows, groupBy: group === 'route' ? 'route' : 'day' });
    } catch (error) {
        console.error('getRevenueReportData error:', error);
        return res.status(500).json({ ok: false, message: 'Không thể tải báo cáo doanh thu.' });
    }
};
