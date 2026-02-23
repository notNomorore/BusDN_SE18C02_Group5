const { Route } = require('../models'); // ✅ chỉnh nếu models export khác

// ===============================
// Helpers
// ===============================
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const safeUpper = (v) => clean(v).toUpperCase();
const isValidStatus = (s) => ['ACTIVE', 'INACTIVE'].includes(s);

// Lấy flash từ session (nếu bạn chưa dùng connect-flash)
function getFlash(req, key) {
  const msg = req.session?.[key] || null;
  if (req.session) delete req.session[key];
  return msg;
}

function setFlash(req, key, value) {
  if (req.session) req.session[key] = value;
}

// ===============================
// GET /admin/routes
// Hiển thị danh sách tuyến + modal UC33
// ===============================
exports.getRoutesPage = async (req, res) => {
  try {
    const routes = await Route.find({}).sort({ createdAt: -1 }).lean();

    return res.render('admin/routes', {
      routes,
      success: getFlash(req, 'success'),
      error: getFlash(req, 'error')
    });
  } catch (err) {
    console.error('❌ getRoutesPage error:', err);
    return res.render('admin/routes', {
      routes: [],
      success: null,
      error: 'Không thể tải danh sách tuyến.'
    });
  }
};

// ===============================
// UC33 - POST /admin/routes/create
// Tạo tuyến xe mới
// ===============================
exports.createRoute = async (req, res) => {
  try {
    let {
      routeNumber,
      name,
      distance,
      startTime,
      endTime,
      status,
      description
    } = req.body;

    routeNumber = safeUpper(routeNumber);
    name = clean(name);
    description = clean(description);
    startTime = clean(startTime);
    endTime = clean(endTime);
    status = clean(status) || 'ACTIVE';

    // Validate required
    if (!routeNumber || !name || distance === undefined || distance === null || distance === '') {
      setFlash(req, 'error', 'Vui lòng nhập đầy đủ Mã tuyến, Tên tuyến, Cự ly.');
      return res.redirect('/admin/routes');
    }

    const distanceNum = Number(distance);
    if (Number.isNaN(distanceNum) || distanceNum <= 0) {
      setFlash(req, 'error', 'Cự ly phải là số lớn hơn 0.');
      return res.redirect('/admin/routes');
    }

    if (!isValidStatus(status)) status = 'ACTIVE';

    // Validate giờ hoạt động
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if ((startTime && !endTime) || (!startTime && endTime)) {
      setFlash(req, 'error', 'Nếu nhập giờ hoạt động thì phải nhập đủ cả giờ bắt đầu và giờ kết thúc.');
      return res.redirect('/admin/routes');
    }

    if (startTime && endTime) {
      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        setFlash(req, 'error', 'Giờ hoạt động không đúng định dạng HH:mm.');
        return res.redirect('/admin/routes');
      }
    }

    // Check trùng mã tuyến
    const existed = await Route.findOne({ routeNumber }).lean();
    if (existed) {
      setFlash(req, 'error', `Mã tuyến "${routeNumber}" đã tồn tại.`);
      return res.redirect('/admin/routes');
    }

    // Tạo object lưu DB
    const payload = {
      routeNumber,
      name,
      distance: distanceNum,
      description,
      status
    };

    if (startTime && endTime) {
      payload.operationTime = {
        start: startTime,
        end: endTime
      };
    }

    await Route.create(payload);

    setFlash(req, 'success', `Đã tạo tuyến "${routeNumber} - ${name}" thành công.`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('❌ createRoute error:', err);

    // Mongo duplicate key
    if (err.code === 11000) {
      setFlash(req, 'error', 'Mã tuyến đã tồn tại.');
      return res.redirect('/admin/routes');
    }

    setFlash(req, 'error', 'Có lỗi xảy ra khi tạo tuyến.');
    return res.redirect('/admin/routes');
  }
};