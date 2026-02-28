const { Stop } = require('../models');

// ===============================
// Helpers
// ===============================
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

// ===============================
// GET /admin/stops
// ===============================
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

    return res.render('admin/stops', {
      stops,
      success: getFlash(req, 'success'),
      error: getFlash(req, 'error'),
      filters: {
        q,
        status
      }
    });
  } catch (err) {
    console.error('❌ getStopsPage error:', err);
    return res.render('admin/stops', {
      stops: [],
      success: null,
      error: 'Không thể tải danh sách trạm dừng.',
      filters: {
        q: '',
        status: ''
      }
    });
  }
};

// ===============================
// POST /admin/stops/create
// ===============================
exports.createStop = async (req, res) => {
  try {
    let { name, address, lat, lng, isTerminal, status } = req.body;

    name = clean(name);
    address = clean(address);
    status = clean(status) || 'ACTIVE';

    if (!name || lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') {
      setFlash(req, 'error', 'Vui lòng nhập đầy đủ Tên trạm, Vĩ độ và Kinh độ.');
      return res.redirect('/admin/stops');
    }

    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
      setFlash(req, 'error', 'Vĩ độ không hợp lệ.');
      return res.redirect('/admin/stops');
    }

    if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      setFlash(req, 'error', 'Kinh độ không hợp lệ.');
      return res.redirect('/admin/stops');
    }

    const existed = await Stop.findOne({ name }).lean();
    if (existed) {
      setFlash(req, 'error', `Trạm "${name}" đã tồn tại.`);
      return res.redirect('/admin/stops');
    }

    await Stop.create({
      name,
      address,
      lat: latNum,
      lng: lngNum,
      isTerminal: isTerminal === 'on',
      status: isValidStatus(status) ? status : 'ACTIVE'
    });

    setFlash(req, 'success', `Đã tạo trạm "${name}" thành công.`);
    return res.redirect('/admin/stops');
  } catch (err) {
    console.error('❌ createStop error:', err);
    setFlash(req, 'error', 'Có lỗi xảy ra khi tạo trạm dừng.');
    return res.redirect('/admin/stops');
  }
};

// ===============================
// POST /admin/stops/:id/update
// ===============================
exports.updateStop = async (req, res) => {
  try {
    const { id } = req.params;
    let { name, address, lat, lng, isTerminal, status } = req.body;

    name = clean(name);
    address = clean(address);
    status = clean(status) || 'ACTIVE';

    if (!name || lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') {
      setFlash(req, 'error', 'Vui lòng nhập đầy đủ Tên trạm, Vĩ độ và Kinh độ.');
      return res.redirect('/admin/stops');
    }

    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
      setFlash(req, 'error', 'Vĩ độ không hợp lệ.');
      return res.redirect('/admin/stops');
    }

    if (Number.isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      setFlash(req, 'error', 'Kinh độ không hợp lệ.');
      return res.redirect('/admin/stops');
    }

    const stop = await Stop.findById(id);
    if (!stop) {
      setFlash(req, 'error', 'Không tìm thấy trạm cần cập nhật.');
      return res.redirect('/admin/stops');
    }

    const existed = await Stop.findOne({
      name,
      _id: { $ne: id }
    }).lean();

    if (existed) {
      setFlash(req, 'error', `Trạm "${name}" đã tồn tại.`);
      return res.redirect('/admin/stops');
    }

    stop.name = name;
    stop.address = address;
    stop.lat = latNum;
    stop.lng = lngNum;
    stop.isTerminal = isTerminal === 'on';
    stop.status = isValidStatus(status) ? status : 'ACTIVE';

    await stop.save();

    setFlash(req, 'success', `Đã cập nhật trạm "${name}" thành công.`);
    return res.redirect('/admin/stops');
  } catch (err) {
    console.error('❌ updateStop error:', err);
    setFlash(req, 'error', 'Có lỗi xảy ra khi cập nhật trạm dừng.');
    return res.redirect('/admin/stops');
  }
};

// ===============================
// POST /admin/stops/:id/deactivate
// ===============================
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
    console.error('❌ deactivateStop error:', err);
    setFlash(req, 'error', 'Không thể tạm ngưng trạm dừng.');
    return res.redirect('/admin/stops');
  }
};

// ===============================
// POST /admin/stops/:id/activate
// ===============================
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
    console.error('❌ activateStop error:', err);
    setFlash(req, 'error', 'Không thể kích hoạt lại trạm dừng.');
    return res.redirect('/admin/stops');
  }
};