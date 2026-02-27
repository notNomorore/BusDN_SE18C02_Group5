const { Route } = require('../models');

// ===============================
// Helpers
// ===============================
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const safeUpper = (v) => clean(v).toUpperCase();
const isValidStatus = (s) => ['ACTIVE', 'INACTIVE'].includes(s);
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
  if (!timeRegex.test(hhmm || '')) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Lấy flash từ session (nếu bạn chưa dùng connect-flash)
function getFlash(req, key) {
  const msg = req.session?.[key] || null;
  if (req.session) delete req.session[key];
  return msg;
}

function setFlash(req, key, value) {
  if (req.session) req.session[key] = value;
}

function validateRouteInput({
  routeNumber,
  name,
  distance,
  startTime,
  endTime,
  status,
  monthlyPassPrice
}) {
  if (!routeNumber || !name || distance === undefined || distance === null || distance === '') {
    return 'Vui lòng nhập đầy đủ Mã tuyến, Tên tuyến, Cự ly.';
  }

  const distanceNum = Number(distance);
  if (Number.isNaN(distanceNum) || distanceNum <= 0) {
    return 'Cự ly phải là số lớn hơn 0.';
  }

  const priceNum = Number(monthlyPassPrice);
  if (monthlyPassPrice !== undefined && monthlyPassPrice !== null && monthlyPassPrice !== '') {
    if (Number.isNaN(priceNum) || priceNum < 0) {
      return 'Giá vé tháng phải là số lớn hơn hoặc bằng 0.';
    }
  }

  if (status && !isValidStatus(status)) {
    return 'Trạng thái tuyến không hợp lệ.';
  }

  if ((startTime && !endTime) || (!startTime && endTime)) {
    return 'Nếu nhập giờ hoạt động thì phải nhập đủ cả giờ bắt đầu và giờ kết thúc.';
  }

  if (startTime && endTime) {
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return 'Giờ hoạt động không đúng định dạng HH:mm.';
    }

    const startMin = toMinutes(startTime);
    const endMin = toMinutes(endTime);
    if (startMin !== null && endMin !== null && endMin <= startMin) {
      return 'Giờ kết thúc phải lớn hơn giờ bắt đầu.';
    }
  }

  return null;
}

// ===============================
// GET /admin/routes
// Hiển thị danh sách tuyến + modal create/edit/detail
// ===============================
exports.getRoutesPage = async (req, res) => {
  console.log(">>> HIT getRoutesPage /admin/routes");
  try {
    const q = clean(req.query.q);
    const status = clean(req.query.status);

    const filter = {};

    if (q) {
      filter.$or = [
        { routeNumber: { $regex: q, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } }
      ];
    }

    if (isValidStatus(status)) {
      filter.status = status;
    }

    const routes = await Route.find(filter)
      .sort({ routeNumber: 1, createdAt: -1 })
      .lean();

    return res.render('admin/routes', {
      routes,
      success: getFlash(req, 'success'),
      error: getFlash(req, 'error'),
      filters: {
        q,
        status
      }
    });
  } catch (err) {
    console.error('❌ getRoutesPage error:', err);
    return res.render('admin/routes', {
      routes: [],
      success: null,
      error: 'Không thể tải danh sách tuyến.',
      filters: {
        q: '',
        status: ''
      }
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
      description,
      monthlyPassPrice
    } = req.body;

    routeNumber = safeUpper(routeNumber);
    name = clean(name);
    description = clean(description);
    startTime = clean(startTime);
    endTime = clean(endTime);
    status = clean(status) || 'ACTIVE';
    monthlyPassPrice = clean(monthlyPassPrice);

    const validateError = validateRouteInput({
      routeNumber,
      name,
      distance,
      startTime,
      endTime,
      status,
      monthlyPassPrice
    });

    if (validateError) {
      setFlash(req, 'error', validateError);
      return res.redirect('/admin/routes');
    }

    const existed = await Route.findOne({ routeNumber }).lean();
    if (existed) {
      setFlash(req, 'error', `Mã tuyến "${routeNumber}" đã tồn tại.`);
      return res.redirect('/admin/routes');
    }

    const payload = {
      routeNumber,
      name,
      distance: Number(distance),
      description,
      status: isValidStatus(status) ? status : 'ACTIVE',
      monthlyPassPrice:
        monthlyPassPrice === '' || monthlyPassPrice === undefined || monthlyPassPrice === null
          ? 200000
          : Number(monthlyPassPrice)
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

    if (err.code === 11000) {
      setFlash(req, 'error', 'Mã tuyến đã tồn tại.');
      return res.redirect('/admin/routes');
    }

    setFlash(req, 'error', 'Có lỗi xảy ra khi tạo tuyến.');
    return res.redirect('/admin/routes');
  }
};

// ===============================
// UC34 - POST /admin/routes/:id/update
// Cập nhật tuyến xe
// ===============================
exports.updateRoute = async (req, res) => {
  try {
    const { id } = req.params;

    let {
      routeNumber,
      name,
      distance,
      startTime,
      endTime,
      status,
      description,
      monthlyPassPrice
    } = req.body;

    routeNumber = safeUpper(routeNumber);
    name = clean(name);
    description = clean(description);
    startTime = clean(startTime);
    endTime = clean(endTime);
    status = clean(status) || 'ACTIVE';
    monthlyPassPrice = clean(monthlyPassPrice);

    const validateError = validateRouteInput({
      routeNumber,
      name,
      distance,
      startTime,
      endTime,
      status,
      monthlyPassPrice
    });

    if (validateError) {
      setFlash(req, 'error', validateError);
      return res.redirect('/admin/routes');
    }

    const route = await Route.findById(id);
    if (!route) {
      setFlash(req, 'error', 'Không tìm thấy tuyến cần cập nhật.');
      return res.redirect('/admin/routes');
    }

    const existed = await Route.findOne({
      routeNumber,
      _id: { $ne: id }
    }).lean();

    if (existed) {
      setFlash(req, 'error', `Mã tuyến "${routeNumber}" đã tồn tại.`);
      return res.redirect('/admin/routes');
    }

    route.routeNumber = routeNumber;
    route.name = name;
    route.distance = Number(distance);
    route.description = description;
    route.status = isValidStatus(status) ? status : 'ACTIVE';
    route.monthlyPassPrice =
      monthlyPassPrice === '' || monthlyPassPrice === undefined || monthlyPassPrice === null
        ? 200000
        : Number(monthlyPassPrice);

    if (startTime && endTime) {
      route.operationTime = {
        start: startTime,
        end: endTime
      };
    } else {
      route.operationTime = undefined;
    }

    await route.save();

    setFlash(req, 'success', `Đã cập nhật tuyến "${route.routeNumber} - ${route.name}" thành công.`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('❌ updateRoute error:', err);

    if (err.code === 11000) {
      setFlash(req, 'error', 'Mã tuyến đã tồn tại.');
      return res.redirect('/admin/routes');
    }

    setFlash(req, 'error', 'Có lỗi xảy ra khi cập nhật tuyến.');
    return res.redirect('/admin/routes');
  }
};

// ===============================
// UC35 - POST /admin/routes/:id/deactivate
// Tạm ngưng tuyến
// ===============================
exports.deactivateRoute = async (req, res) => {
  try {
    const { id } = req.params;

    const route = await Route.findByIdAndUpdate(
      id,
      { $set: { status: 'INACTIVE' } },
      { new: true }
    ).lean();

    if (!route) {
      setFlash(req, 'error', 'Không tìm thấy tuyến để tạm ngưng.');
      return res.redirect('/admin/routes');
    }

    setFlash(req, 'success', `Đã tạm ngưng tuyến "${route.routeNumber} - ${route.name}".`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('❌ deactivateRoute error:', err);
    setFlash(req, 'error', 'Không thể tạm ngưng tuyến.');
    return res.redirect('/admin/routes');
  }
};

// ===============================
// POST /admin/routes/:id/activate
// Kích hoạt lại tuyến
// ===============================
exports.activateRoute = async (req, res) => {
  try {
    const { id } = req.params;

    const route = await Route.findByIdAndUpdate(
      id,
      { $set: { status: 'ACTIVE' } },
      { new: true }
    ).lean();

    if (!route) {
      setFlash(req, 'error', 'Không tìm thấy tuyến để kích hoạt.');
      return res.redirect('/admin/routes');
    }

    setFlash(req, 'success', `Đã kích hoạt lại tuyến "${route.routeNumber} - ${route.name}".`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('❌ activateRoute error:', err);
    setFlash(req, 'error', 'Không thể kích hoạt lại tuyến.');
    return res.redirect('/admin/routes');
  }
};