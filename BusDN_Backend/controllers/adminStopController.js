const { Stop } = require('../models');
const { renderAdmin } = require('../middleware/renderAdmin');

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const isValidStatus = (s) => ['ACTIVE', 'INACTIVE'].includes(s);

function getFlash(req, key) {
  const msg = req.session?.[key] || null;
  if (req.session) delete req.session[key];
  return msg;
}

function setFlash(req, key, value) {
  if (req.session) req.session[key] = value;
}

function normalizeStopPayload(input = {}) {
  return {
    name: clean(input.name),
    address: clean(input.address),
    latRaw: input.lat,
    lngRaw: input.lng,
    status: clean(input.status) || 'ACTIVE'
  };
}

function parseCoordinate(value) {
  if (value === undefined || value === null || value === '') return Number.NaN;
  const normalized = String(value).trim().replace(',', '.');
  return Number(normalized);
}

async function validateStopPayload(payload, currentStopId = null) {
  const errors = [];

  if (!payload.name || payload.latRaw === undefined || payload.latRaw === null || payload.latRaw === '' || payload.lngRaw === undefined || payload.lngRaw === null || payload.lngRaw === '') {
    errors.push('Vui lòng nhập đầy đủ Tên trạm, Vĩ độ và Kinh độ.');
  }

  const latNum = parseCoordinate(payload.latRaw);
  const lngNum = parseCoordinate(payload.lngRaw);

  if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
    errors.push('Vĩ độ không hợp lệ.');
  }

  if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
    errors.push('Kinh độ không hợp lệ.');
  }

  if (!isValidStatus(payload.status)) {
    errors.push('Trạng thái không hợp lệ.');
  }

  if (payload.name) {
    const duplicateFilter = currentStopId
      ? { name: payload.name, _id: { $ne: currentStopId } }
      : { name: payload.name };
    const existed = await Stop.findOne(duplicateFilter).lean();
    if (existed) {
      errors.push(`Trạm "${payload.name}" đã tồn tại.`);
    }
  }

  return {
    errors,
    data: {
      name: payload.name,
      address: payload.address,
      lat: latNum,
      lng: lngNum,
      isTerminal: false,
      status: isValidStatus(payload.status) ? payload.status : 'ACTIVE'
    }
  };
}

function mapStopForClient(stop) {
  return {
    id: String(stop._id),
    name: stop.name,
    address: stop.address || '',
    status: stop.status || 'ACTIVE',
    lat: stop.lat,
    lng: stop.lng
  };
}

exports.getStopsPage = async (req, res) => {
  try {
    const q = clean(req.query.q);
    const status = clean(req.query.status);
    const filter = {};

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { address: { $regex: q, $options: 'i' } }
      ];
    }

    if (isValidStatus(status)) {
      filter.status = status;
    }

    const stops = await Stop.find(filter)
      .sort({ createdAt: -1, name: 1 })
      .lean();

    return renderAdmin(req, res, 'admin/stops', 'Quản lý trạm dừng', {
      path: 'stops',
      stops,
      success: getFlash(req, 'success'),
      error: getFlash(req, 'error'),
      filters: { q, status }
    });
  } catch (err) {
    console.error('getStopsPage error:', err);
    return renderAdmin(req, res, 'admin/stops', 'Quản lý trạm dừng', {
      path: 'stops',
      stops: [],
      success: null,
      error: 'Không thể tải danh sách trạm dừng.',
      filters: { q: '', status: '' }
    });
  }
};

exports.createStop = async (req, res) => {
  try {
    const payload = normalizeStopPayload(req.body);
    const { errors, data } = await validateStopPayload(payload);
    const redirectTo = clean(req.body.redirectTo) || '/admin/stops';

    if (errors.length) {
      setFlash(req, 'error', errors[0]);
      return res.redirect(redirectTo);
    }

    await Stop.create(data);

    setFlash(req, 'success', `Đã tạo trạm "${data.name}" thành công.`);
    return res.redirect(redirectTo);
  } catch (err) {
    console.error('createStop error:', err);
    setFlash(req, 'error', 'Có lỗi xảy ra khi tạo trạm dừng.');
    return res.redirect(clean(req.body.redirectTo) || '/admin/stops');
  }
};

exports.createStopAjax = async (req, res) => {
  try {
    const payload = normalizeStopPayload(req.body);
    const { errors, data } = await validateStopPayload(payload);

    if (errors.length) {
      return res.status(400).json({ ok: false, error: errors[0], errors });
    }

    const stop = await Stop.create(data);
    return res.json({
      ok: true,
      message: `Đã tạo trạm "${stop.name}" thành công.`,
      stop: mapStopForClient(stop)
    });
  } catch (err) {
    console.error('createStopAjax error:', err);
    return res.status(500).json({
      ok: false,
      error: 'Có lỗi xảy ra khi tạo trạm dừng.'
    });
  }
};

exports.updateStop = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = normalizeStopPayload(req.body);
    const { errors, data } = await validateStopPayload(payload, id);

    if (errors.length) {
      setFlash(req, 'error', errors[0]);
      return res.redirect('/admin/stops');
    }

    const stop = await Stop.findById(id);
    if (!stop) {
      setFlash(req, 'error', 'Không tìm thấy trạm cần cập nhật.');
      return res.redirect('/admin/stops');
    }

    stop.name = data.name;
    stop.address = data.address;
    stop.lat = data.lat;
    stop.lng = data.lng;
    stop.status = data.status;

    await stop.save();

    setFlash(req, 'success', `Đã cập nhật trạm "${data.name}" thành công.`);
    return res.redirect('/admin/stops');
  } catch (err) {
    console.error('updateStop error:', err);
    setFlash(req, 'error', 'Có lỗi xảy ra khi cập nhật trạm dừng.');
    return res.redirect('/admin/stops');
  }
};

exports.deactivateStop = async (req, res) => {
  try {
    const { id } = req.params;
    const stop = await Stop.findByIdAndUpdate(
      id,
      { $set: { status: 'INACTIVE' } },
      { new: true }
    ).lean();

    if (!stop) {
      setFlash(req, 'error', 'Không tìm thấy trạm để tạm ngưng.');
      return res.redirect('/admin/stops');
    }

    setFlash(req, 'success', `Đã tạm ngưng trạm "${stop.name}".`);
    return res.redirect('/admin/stops');
  } catch (err) {
    console.error('deactivateStop error:', err);
    setFlash(req, 'error', 'Không thể tạm ngưng trạm dừng.');
    return res.redirect('/admin/stops');
  }
};

exports.activateStop = async (req, res) => {
  try {
    const { id } = req.params;
    const stop = await Stop.findByIdAndUpdate(
      id,
      { $set: { status: 'ACTIVE' } },
      { new: true }
    ).lean();

    if (!stop) {
      setFlash(req, 'error', 'Không tìm thấy trạm để kích hoạt.');
      return res.redirect('/admin/stops');
    }

    setFlash(req, 'success', `Đã kích hoạt lại trạm "${stop.name}".`);
    return res.redirect('/admin/stops');
  } catch (err) {
    console.error('activateStop error:', err);
    setFlash(req, 'error', 'Không thể kích hoạt lại trạm dừng.');
    return res.redirect('/admin/stops');
  }
};
