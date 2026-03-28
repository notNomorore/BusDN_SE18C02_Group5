const { Route, Stop, Schedule, TripTicket } = require('../models/models');
const { renderAdmin } = require('../middleware/renderAdmin');
// ===============================
// Helpers
// ===============================
const mongoose = require('mongoose');

const ROUTE_STATUS = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'SCHEDULED',
  'ACTIVE',
  'REJECTED',
  'SUSPENDED',
  'INACTIVE'
];

const ROUTE_STOP_STATUS = ['ACTIVE', 'INACTIVE'];
const ROUTE_TYPE_OPTIONS = ['REGULAR', 'EXPRESS', 'LOOP', 'SHUTTLE'];
const SERVICE_TYPE_OPTIONS = ['URBAN', 'SUBURBAN', 'SCHOOL', 'AIRPORT', 'SPECIAL'];
const OPERATING_DAY_OPTIONS = [
  { value: 'MONDAY', label: 'Thứ 2' },
  { value: 'TUESDAY', label: 'Thứ 3' },
  { value: 'WEDNESDAY', label: 'Thứ 4' },
  { value: 'THURSDAY', label: 'Thứ 5' },
  { value: 'FRIDAY', label: 'Thứ 6' },
  { value: 'SATURDAY', label: 'Thứ 7' },
  { value: 'SUNDAY', label: 'Chủ nhật' }
];

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const safeUpper = (v) => clean(v).toUpperCase();
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Giới hạn thời điểm sinh lịch: xe phải về muộn nhất trước 19:30
const LAST_OPERATION_END_CAP = '19:30';

function getFlash(req, key) {
  const msg = req.session?.[key] || null;
  if (req.session) delete req.session[key];
  return msg;
}

function setFlash(req, key, value) {
  if (req.session) req.session[key] = value;
}

function isValidRouteStatus(status) {
  return ROUTE_STATUS.includes(clean(status).toUpperCase());
}

function toMinutes(hhmm) {
  if (!timeRegex.test(hhmm || '')) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function parseNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePositiveNumberOrNull(value) {
  const n = parseNumberOrNull(value);
  if (n === null) return null;
  return n >= 0 ? n : null;
}

function parseDateOrNull(value) {
  const raw = clean(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeStringArray(input) {
  if (Array.isArray(input)) {
    return input.map((v) => clean(v).toUpperCase()).filter(Boolean);
  }
  const raw = clean(input);
  return raw ? [raw.toUpperCase()] : [];
}

function parseJsonArray(rawValue) {
  if (Array.isArray(rawValue)) return rawValue;
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(String(rawValue));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function normalizeDirectionStops(rawValue) {
  const rows = parseJsonArray(rawValue);
  return rows.map((item, index) => {
    const stopId = clean(item?.stopId);
    return {
      stopId,
      sequenceOrder: index + 1,
      estimatedMinutesFromStart: parsePositiveNumberOrNull(item?.estimatedMinutesFromStart) ?? 0,
      distanceFromStart: parsePositiveNumberOrNull(item?.distanceFromStart) ?? 0,
      pickupAllowed: item?.pickupAllowed === false || item?.pickupAllowed === 'false' ? false : true,
      dropoffAllowed: item?.dropoffAllowed === false || item?.dropoffAllowed === 'false' ? false : true,
      status: ROUTE_STOP_STATUS.includes(clean(item?.status).toUpperCase())
        ? clean(item.status).toUpperCase()
        : 'ACTIVE'
    };
  }).filter((item) => item.stopId);
}

function makeRouteCreateFormData(input = {}) {
  const routeCode = safeUpper(input.routeCode || input.routeNumber);
  const outboundStops = Array.isArray(input.outboundStops) ? input.outboundStops : [];
  const inboundStops = Array.isArray(input.inboundStops) ? input.inboundStops : [];
  const operatingDays = normalizeStringArray(input.operatingDays);

  return {
    routeCode,
    routeName: clean(input.routeName || input.name),
    distance: input.distance ?? input.routeDistance ?? '',
    routeType: clean(input.routeType),
    serviceType: clean(input.serviceType),
    startPoint: clean(input.startPoint || (input.startStopId ? String(input.startStopId) : '')),
    endPoint: clean(input.endPoint || (input.endStopId ? String(input.endStopId) : '')),
    description: clean(input.description),
    effectiveDate: input.effectiveDate ? String(input.effectiveDate).slice(0, 10) : '',
    status: isValidRouteStatus(input.status) ? clean(input.status).toUpperCase() : 'DRAFT',
    operatingDays,
    startTime: clean(input.startTime || input.operationSettings?.startTime || ''),
    endTime: clean(input.endTime || input.operationSettings?.endTime || ''),
    tripInterval: input.tripInterval ?? input.operationSettings?.tripInterval ?? '',
    estimatedRouteDuration: input.estimatedRouteDuration ?? input.operationSettings?.estimatedRouteDuration ?? '',
    turnaroundTime: input.turnaroundTime ?? input.operationSettings?.turnaroundTime ?? '',
    notes: clean(input.notes || input.operationSettings?.notes || ''),
    outboundStops,
    inboundStops
  };
}

function getRouteFormLookups() {
  return {
    routeTypeOptions: ROUTE_TYPE_OPTIONS,
    serviceTypeOptions: SERVICE_TYPE_OPTIONS,
    statusOptions: ROUTE_STATUS,
    stopStatusOptions: ROUTE_STOP_STATUS,
    operatingDayOptions: OPERATING_DAY_OPTIONS
  };
}

function mapDirectionStopsForView(items = []) {
  return items.map((item, index) => ({
    stopId: item.stopId ? String(item.stopId) : '',
    sequenceOrder: index + 1,
    estimatedMinutesFromStart: item.estimatedMinutesFromStart ?? 0,
    distanceFromStart: item.distanceFromStart ?? 0,
    pickupAllowed: item.pickupAllowed !== false,
    dropoffAllowed: item.dropoffAllowed !== false,
    status: item.status || 'ACTIVE'
  }));
}

function buildCreatePagePayload(formData = {}, extra = {}) {
  return {
    path: 'routes',
    formData: makeRouteCreateFormData(formData),
    ...getRouteFormLookups(),
    success: extra.success || null,
    error: extra.error || null,
    errors: Array.isArray(extra.errors) ? extra.errors : [],
    availableStops: Array.isArray(extra.availableStops) ? extra.availableStops : []
  };
}

async function loadStopsForAdmin(activeOnly = false) {
  const filter = activeOnly ? { status: 'ACTIVE' } : {};
  return Stop.find(filter)
    .sort({ status: 1, isTerminal: -1, name: 1 })
    .select('_id name address isTerminal status lat lng')
    .lean();
}

function normalizeRouteListStatus(status) {
  const raw = clean(status).toUpperCase();
  return ROUTE_STATUS.includes(raw) ? raw : '';
}

function mapLegacyStopsToView(route, direction) {
  const allStops = Array.isArray(route.stops) ? route.stops : [];
  return allStops
    .filter((item) => item.direction === direction && item.stopId)
    .sort((a, b) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0))
    .map((item, index) => ({
      id: String(item.stopId._id),
      stopId: String(item.stopId._id),
      name: item.stopId.name,
      address: item.stopId.address || '',
      isTerminal: Boolean(item.stopId.isTerminal),
      sequenceOrder: index + 1,
      estimatedMinutesFromStart: item.estimatedMinutesFromStart ?? 0,
      distanceFromStart: item.distanceFromStart ?? 0,
      pickupAllowed: item.pickupAllowed !== false,
      dropoffAllowed: item.dropoffAllowed !== false,
      status: item.status || 'ACTIVE'
    }));
}

function buildRouteViewModel(route) {
  const outboundStops = mapLegacyStopsToView(route, 'OUTBOUND');
  const inboundStops = mapLegacyStopsToView(route, 'INBOUND');

  const derivedStartStop = route.startStopId || outboundStops[0] || null;
  const derivedEndStop = route.endStopId || outboundStops[outboundStops.length - 1] || null;

  return {
    ...route,
    routeCode: route.routeNumber,
    routeName: route.name,
    startStop: derivedStartStop,
    endStop: derivedEndStop,
    outboundStops,
    inboundStops,
    stopCount: outboundStops.length
  };
}

function buildRouteNameFromStops(startStop, endStop) {
  const startName = clean(startStop?.name);
  const endName = clean(endStop?.name);
  if (!startName || !endName) return '';
  return `${startName} - ${endName}`;
}

function normalizeCreateRouteErrorMessage(message) {
  const text = String(message || '');
  const mappings = [
    [/^routeCode .*bat buoc\.$/i, 'Mã tuyến là bắt buộc.'],
    [/^routeCode .*báº¯t buá»™c\.$/i, 'Mã tuyến là bắt buộc.'],
    [/^routeCode "(.+)" .*tá»“n táº¡i\.$/i, 'Mã tuyến "$1" đã tồn tại.'],
    [/^startPoint .*bat buoc\.$/i, 'Điểm đầu là bắt buộc.'],
    [/^startPoint .*báº¯t buá»™c\.$/i, 'Điểm đầu là bắt buộc.'],
    [/^endPoint .*bat buoc\.$/i, 'Điểm cuối là bắt buộc.'],
    [/^endPoint .*báº¯t buá»™c\.$/i, 'Điểm cuối là bắt buộc.'],
    [/^startPoint .* endPoint .*trung nhau\.$/i, 'Điểm đầu và điểm cuối không được trùng nhau.'],
    [/^startPoint .* endPoint .*trÃ¹ng nhau\.$/i, 'Điểm đầu và điểm cuối không được trùng nhau.'],
    [/^.*diá»ƒm .*khÃ´ng há»£p lá»‡\.$/i, 'Điểm đầu hoặc điểm cuối không hợp lệ.'],
    [/^.*Ä‘iá»ƒm Ä‘áº§u .*táº¡m ngÆ°ng\.$/i, 'Điểm đầu không tồn tại hoặc đang tạm ngưng.'],
    [/^.*Ä‘iá»ƒm cuá»‘i .*táº¡m ngÆ°ng\.$/i, 'Điểm cuối không tồn tại hoặc đang tạm ngưng.'],
    [/^KhÃ´ng thá»ƒ táº¡o tÃªn tuyáº¿n\..*$/i, 'Không thể tạo tên tuyến. Vui lòng chọn đủ điểm đầu và điểm cuối hợp lệ.'],
    [/^effectiveDate .*submit review\.$/i, 'Ngày hiệu lực là bắt buộc khi gửi duyệt.'],
    [/^effectiveDate .*quÃ¡ khá»©\.$/i, 'Ngày hiệu lực không được ở trong quá khứ.'],
    [/^effectiveDate .*há»£p lá»‡\.$/i, 'Ngày hiệu lực không hợp lệ.'],
    [/^Cá»± ly .*0\.$/i, 'Cự ly là bắt buộc và phải lớn hơn 0.']
  ];

  for (const [pattern, replacement] of mappings) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }

  return text;
}

async function buildStopLookup(stopIds, { activeOnly = false } = {}) {
  const uniqueIds = [...new Set(stopIds.filter(Boolean))];
  const objectIds = [];

  for (const id of uniqueIds) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    objectIds.push(new mongoose.Types.ObjectId(id));
  }

  const filter = { _id: { $in: objectIds } };
  if (activeOnly) filter.status = 'ACTIVE';

  const stops = await Stop.find(filter).select('_id name address isTerminal status').lean();
  return new Map(stops.map((stop) => [String(stop._id), stop]));
}

function validateOperationSettings(formData, { strict = false } = {}) {
  const errors = [];
  const startTime = clean(formData.startTime);
  const endTime = clean(formData.endTime);
  const tripInterval = parseNumberOrNull(formData.tripInterval);
  const estimatedRouteDuration = parseNumberOrNull(formData.estimatedRouteDuration);
  const turnaroundTime = parseNumberOrNull(formData.turnaroundTime);

  if ((startTime && !endTime) || (!startTime && endTime)) {
    errors.push('Nếu nhập giờ vận hành thì phải nhập đủ giờ bắt đầu và giờ kết thúc.');
  }

  if (startTime && endTime) {
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      errors.push('Giờ vận hành phải đúng định dạng HH:mm.');
    } else if (toMinutes(startTime) >= toMinutes(endTime)) {
      errors.push('Giờ bắt đầu phải sớm hơn giờ kết thúc.');
    } else if (toMinutes(endTime) > toMinutes(LAST_OPERATION_END_CAP)) {
      errors.push(`Giờ kết thúc không được vượt quá ${LAST_OPERATION_END_CAP}.`);
    }
  }

  if (tripInterval !== null && tripInterval <= 0) {
    errors.push('Trip interval phải lớn hơn 0.');
  }

  if (estimatedRouteDuration !== null && estimatedRouteDuration <= 0) {
    errors.push('Estimated route duration phải lớn hơn 0.');
  }

  if (turnaroundTime !== null && turnaroundTime < 0) {
    errors.push('Turnaround time không được nhỏ hơn 0.');
  }

  if (strict) {
    if (!formData.operatingDays.length) errors.push('Phải chọn ít nhất 1 ngày vận hành.');
    if (!startTime || !endTime) errors.push('Phải cấu hình đầy đủ giờ vận hành.');
    if (tripInterval === null || tripInterval <= 0) errors.push('Phải nhập trip interval hợp lệ.');
    if (estimatedRouteDuration === null || estimatedRouteDuration <= 0) errors.push('Phải nhập estimated route duration hợp lệ.');
  }

  return errors;
}

async function validateDirection(directionLabel, items, expectedStartStopId, expectedEndStopId, { strict = false } = {}) {
  const errors = [];
  const stopIds = items.map((item) => item.stopId);
  const stopLookup = await buildStopLookup(stopIds, { activeOnly: strict });

  if (!stopLookup) {
    errors.push(`Danh sách trạm chiều ${directionLabel} chứa stopId không hợp lệ.`);
    return { errors, normalizedStops: [] };
  }

  if (strict && items.length < 2) {
    errors.push(`Chiều ${directionLabel} phải có ít nhất 2 trạm.`);
  }

  const seenStopIds = new Set();
  let previousMinutes = -1;
  let previousDistance = -1;

  const normalizedStops = items.map((item, index) => ({
    stopId: item.stopId,
    sequenceOrder: index + 1,
    estimatedMinutesFromStart: parsePositiveNumberOrNull(item.estimatedMinutesFromStart) ?? 0,
    distanceFromStart: parsePositiveNumberOrNull(item.distanceFromStart) ?? 0,
    pickupAllowed: item.pickupAllowed !== false,
    dropoffAllowed: item.dropoffAllowed !== false,
    status: ROUTE_STOP_STATUS.includes(clean(item.status).toUpperCase())
      ? clean(item.status).toUpperCase()
      : 'ACTIVE'
  }));

  normalizedStops.forEach((item, index) => {
    if (!item.stopId) {
      errors.push(`Trạm thứ ${index + 1} của chiều ${directionLabel} thiếu stopId.`);
      return;
    }

    if (!stopLookup.get(String(item.stopId))) {
      errors.push(`Trạm thứ ${index + 1} của chiều ${directionLabel} không tồn tại hoặc đang tạm ngưng.`);
    }

    if (seenStopIds.has(String(item.stopId))) {
      errors.push(`Chiều ${directionLabel} không được chứa trạm trùng lặp.`);
    }
    seenStopIds.add(String(item.stopId));

    if (item.estimatedMinutesFromStart < previousMinutes) {
      errors.push(`Estimated minutes của chiều ${directionLabel} phải tăng dần theo hành trình.`);
    }
    if (item.distanceFromStart < previousDistance) {
      errors.push(`Distance từ đầu tuyến của chiều ${directionLabel} phải tăng dần theo hành trình.`);
    }

    previousMinutes = item.estimatedMinutesFromStart;
    previousDistance = item.distanceFromStart;
  });

  if (strict && normalizedStops.length >= 2) {
    const first = normalizedStops[0];
    const last = normalizedStops[normalizedStops.length - 1];
    if (String(first.stopId) !== String(expectedStartStopId || '')) {
      errors.push(`Chiều ${directionLabel} phải bắt đầu tại điểm đầu/kết thúc tương ứng.`);
    }
    if (String(last.stopId) !== String(expectedEndStopId || '')) {
      errors.push(`Chiều ${directionLabel} phải kết thúc tại điểm cuối/kết thúc tương ứng.`);
    }
  }

  return { errors, normalizedStops };
}

async function validateCreatePayload(formData, mode) {
  const errors = [];
  const strict = mode === 'SUBMIT_REVIEW';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let routeName = '';
  const routeDistanceRaw = parseNumberOrNull(formData.distance);
  const routeDistance = parsePositiveNumberOrNull(formData.distance);

  if (!formData.routeCode) {
    errors.push('routeCode là bắt buộc.');
  }

  if (routeDistanceRaw === null || routeDistanceRaw <= 0) {
    errors.push('Cự ly là bắt buộc và phải lớn hơn 0.');
  }

  if (formData.routeCode) {
    const existed = await Route.findOne({ routeNumber: formData.routeCode }).lean();
    if (existed) {
      errors.push(`routeCode "${formData.routeCode}" đã tồn tại.`);
    }
  }

  if (strict && !formData.startPoint) errors.push('startPoint là bắt buộc.');
  if (strict && !formData.endPoint) errors.push('endPoint là bắt buộc.');
  if (formData.startPoint && formData.endPoint && formData.startPoint === formData.endPoint) {
    errors.push('startPoint và endPoint không được trùng nhau.');
  }

  if (formData.startPoint && formData.endPoint && formData.startPoint !== formData.endPoint) {
    const endpointLookup = await buildStopLookup([formData.startPoint, formData.endPoint], { activeOnly: strict });
    if (!endpointLookup) {
      errors.push('Điểm đầu hoặc điểm cuối không hợp lệ.');
    } else {
      const startStop = endpointLookup.get(String(formData.startPoint));
      const endStop = endpointLookup.get(String(formData.endPoint));
      if (!startStop) errors.push('Điểm đầu không tồn tại hoặc đang tạm ngưng.');
      if (!endStop) errors.push('Điểm cuối không tồn tại hoặc đang tạm ngưng.');
      routeName = buildRouteNameFromStops(startStop, endStop);
    }
  }

  if (strict) {
    if (!routeName) errors.push('Không thể tạo tên tuyến. Vui lòng chọn đủ điểm đầu và điểm cuối hợp lệ.');
    if (!formData.effectiveDate || !parseDateOrNull(formData.effectiveDate)) {
      errors.push('effectiveDate là bắt buộc khi submit review.');
    } else if (parseDateOrNull(formData.effectiveDate) < today) {
      errors.push('effectiveDate không được ở trong quá khứ.');
    }
  } else if (formData.effectiveDate && !parseDateOrNull(formData.effectiveDate)) {
    errors.push('effectiveDate không hợp lệ.');
  } else if (formData.effectiveDate && parseDateOrNull(formData.effectiveDate) < today) {
    errors.push('effectiveDate không được ở trong quá khứ.');
  }

  errors.push(...validateOperationSettings(formData, { strict }));

  const outbound = await validateDirection(
    'đi',
    formData.outboundStops,
    formData.startPoint,
    formData.endPoint,
    { strict }
  );
  const inbound = await validateDirection(
    'về',
    formData.inboundStops,
    formData.endPoint,
    formData.startPoint,
    { strict }
  );

  errors.push(...outbound.errors, ...inbound.errors);
  const normalizedErrors = errors.map(normalizeCreateRouteErrorMessage);

  return {
    errors: normalizedErrors,
    routeName,
    routeDistance,
    outboundStops: outbound.normalizedStops,
    inboundStops: inbound.normalizedStops
  };
}

function buildLegacyStops(outboundStops, inboundStops) {
  const outbound = outboundStops.map((stop) => ({
    stopId: stop.stopId,
    orderIndex: stop.sequenceOrder,
    direction: 'OUTBOUND',
    distanceFromStart: stop.distanceFromStart,
    estimatedMinutesFromStart: stop.estimatedMinutesFromStart,
    pickupAllowed: stop.pickupAllowed,
    dropoffAllowed: stop.dropoffAllowed,
    status: stop.status
  }));

  const inbound = inboundStops.map((stop) => ({
    stopId: stop.stopId,
    orderIndex: stop.sequenceOrder,
    direction: 'INBOUND',
    distanceFromStart: stop.distanceFromStart,
    estimatedMinutesFromStart: stop.estimatedMinutesFromStart,
    pickupAllowed: stop.pickupAllowed,
    dropoffAllowed: stop.dropoffAllowed,
    status: stop.status
  }));

  return [...outbound, ...inbound];
}

function normalizeStopSequence(rawValue) {
  const rows = parseJsonArray(rawValue);
  return rows.map((item) => clean(item)).filter(Boolean);
}

function buildDirectionStopsFromSequence(sequence, existingStops = []) {
  const metadataMap = new Map(
    (Array.isArray(existingStops) ? existingStops : [])
      .filter((item) => item && item.stopId)
      .map((item) => [String(item.stopId), item])
  );

  return sequence.map((stopId, index) => {
    const previous = metadataMap.get(String(stopId)) || {};
    return {
      stopId,
      sequenceOrder: index + 1,
      estimatedMinutesFromStart: parsePositiveNumberOrNull(previous.estimatedMinutesFromStart) ?? 0,
      distanceFromStart: parsePositiveNumberOrNull(previous.distanceFromStart) ?? 0,
      pickupAllowed: previous.pickupAllowed !== false,
      dropoffAllowed: previous.dropoffAllowed !== false,
      status: ROUTE_STOP_STATUS.includes(clean(previous.status).toUpperCase())
        ? clean(previous.status).toUpperCase()
        : 'ACTIVE'
    };
  });
}

function buildAuditLog({ action, fromStatus = null, toStatus = null, message = '', req }) {
  return {
    action,
    fromStatus,
    toStatus,
    message,
    performedBy: req.session?.userId || null,
    performedAt: new Date()
  };
}

function deriveRouteDistance(outboundStops, inboundStops) {
  const candidates = [];
  if (outboundStops.length) candidates.push(Number(outboundStops[outboundStops.length - 1].distanceFromStart || 0));
  if (inboundStops.length) candidates.push(Number(inboundStops[inboundStops.length - 1].distanceFromStart || 0));
  const maxDistance = Math.max(0, ...candidates);
  return Number.isFinite(maxDistance) ? maxDistance : 0;
}

async function getRouteDeactivationBlockers(routeId) {
  const activeSchedules = await Schedule.find({
    routeId,
    archived: { $ne: true },
    status: { $in: ['SCHEDULED', 'IN_PROGRESS'] }
  })
    .select('_id status trackingActive passengerCount')
    .lean();

  const scheduleIds = activeSchedules.map((schedule) => schedule._id);
  const runningSchedulesCount = activeSchedules.filter(
    (schedule) =>
      schedule.status === 'IN_PROGRESS' ||
      schedule.trackingActive === true ||
      Number(schedule.passengerCount || 0) > 0
  ).length;

  const activeTripTicketCount = scheduleIds.length
    ? await TripTicket.countDocuments({
      scheduleId: { $in: scheduleIds },
      status: { $in: ['BOOKED', 'USED'] }
    })
    : 0;

  return {
    activeSchedulesCount: activeSchedules.length,
    runningSchedulesCount,
    activeTripTicketCount
  };
}

async function validateRouteDeactivation(routeId) {
  const blockers = await getRouteDeactivationBlockers(routeId);

  if (blockers.runningSchedulesCount > 0) {
    return `Không thể tạm ngưng tuyến vì đang có ${blockers.runningSchedulesCount} chuyến đang chạy hoặc đang chở khách.`;
  }

  if (blockers.activeTripTicketCount > 0) {
    return `Không thể tạm ngưng tuyến vì còn ${blockers.activeTripTicketCount} vé lượt đã đặt/đang sử dụng trên các chuyến chưa hoàn tất.`;
  }

  if (blockers.activeSchedulesCount > 0) {
    return `Không thể tạm ngưng tuyến vì còn ${blockers.activeSchedulesCount} chuyến đã được lên lịch.`;
  }

  return null;
}

exports.getCreateRoutePage = async (req, res) => {
  try {
    const availableStops = await loadStopsForAdmin();
    return renderAdmin(
      req,
      res,
      'admin/route-create',
      'Tạo tuyến xe',
      buildCreatePagePayload({}, {
        availableStops,
        error: req.query.error || null,
        success: req.query.success || null
      })
    );
  } catch (err) {
    console.error('getCreateRoutePage error:', err);
    return renderAdmin(req, res, 'admin/route-create', 'Tạo tuyến xe', buildCreatePagePayload({}, {
      availableStops: [],
      error: 'Không thể tải trang tạo tuyến.',
      errors: []
    }));
  }
};

exports.getRoutesPage = async (req, res) => {
  console.log('>>> HIT getRoutesPage /admin/routes');

  try {
    const q = clean(req.query.q);
    const status = normalizeRouteListStatus(req.query.status);
    const filter = {};

    if (q) {
      filter.$or = [
        { routeNumber: { $regex: q, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } }
      ];
    }

    if (status) filter.status = status;

    const [routes, availableStops] = await Promise.all([
      Route.find(filter)
        .populate('startStopId', 'name address isTerminal')
        .populate('endStopId', 'name address isTerminal')
        .populate('stops.stopId', 'name address isTerminal')
        .sort({ createdAt: -1, routeNumber: 1 })
        .lean(),
      loadStopsForAdmin()
    ]);

    return renderAdmin(req, res, 'admin/routes', 'Quản lý tuyến xe', {
      path: 'routes',
      routes: routes.map(buildRouteViewModel), // 🔥 giữ feature mới
      availableStops,                          // 🔥 giữ
      success: getFlash(req, 'success'),
      error: getFlash(req, 'error'),
      filters: { q, status },
      statusOptions: ROUTE_STATUS              // 🔥 giữ
    });

  } catch (err) {
    console.error('getRoutesPage error:', err);

    return renderAdmin(req, res, 'admin/routes', 'Quản lý tuyến xe', {
      path: 'routes',
      routes: [],
      availableStops: [],
      success: null,
      error: 'Không thể tải danh sách tuyến.',
      filters: { q: '', status: '' },
      statusOptions: ROUTE_STATUS
    });
  }
};

exports.createRoute = async (req, res) => {
  try {
    const intent = clean(req.body.intent).toLowerCase() === 'submit_review' ? 'SUBMIT_REVIEW' : 'SAVE_DRAFT';
    const formData = makeRouteCreateFormData({
      routeCode: req.body.routeCode,
      distance: req.body.distance,
      routeType: req.body.routeType,
      serviceType: req.body.serviceType,
      startPoint: req.body.startPoint,
      endPoint: req.body.endPoint,
      description: req.body.description,
      effectiveDate: req.body.effectiveDate,
      operatingDays: req.body.operatingDays,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      tripInterval: req.body.tripInterval,
      estimatedRouteDuration: req.body.estimatedRouteDuration,
      turnaroundTime: req.body.turnaroundTime,
      notes: req.body.notes,
      outboundStops: normalizeDirectionStops(req.body.outboundStopsJson),
      inboundStops: normalizeDirectionStops(req.body.inboundStopsJson)
    });

    const { errors, routeName, routeDistance, outboundStops, inboundStops } = await validateCreatePayload(formData, intent);
    formData.routeName = routeName || formData.routeName;

    if (errors.length) {
      const availableStops = await loadStopsForAdmin();
      return renderAdmin(
        req,
        res,
        'admin/route-create',
        'Tạo tuyến xe',
        buildCreatePagePayload(
          {
            ...formData,
            outboundStops: mapDirectionStopsForView(outboundStops.length ? outboundStops : formData.outboundStops),
            inboundStops: mapDirectionStopsForView(inboundStops.length ? inboundStops : formData.inboundStops)
          },
          {
            availableStops,
            error: errors[0],
            errors
          }
        )
      );
    }

    const nextStatus = intent === 'SUBMIT_REVIEW' ? 'PENDING_REVIEW' : 'DRAFT';
    const auditLogs = [
      buildAuditLog({
        action: intent === 'SUBMIT_REVIEW' ? 'SUBMIT_FOR_REVIEW' : 'SAVE_DRAFT',
        fromStatus: null,
        toStatus: nextStatus,
        message: intent === 'SUBMIT_REVIEW'
          ? 'Tạo tuyến và gửi phê duyệt.'
          : 'Tạo tuyến ở trạng thái nháp.',
        req
      })
    ];

    await Route.create({
      routeNumber: formData.routeCode,
      name: routeName || formData.routeName,
      routeType: formData.routeType,
      serviceType: formData.serviceType,
      description: formData.description,
      distance: routeDistance,
      startStopId: formData.startPoint || null,
      endStopId: formData.endPoint || null,
      effectiveDate: parseDateOrNull(formData.effectiveDate),
      status: nextStatus,
      operationTime: {
        start: formData.startTime || '',
        end: formData.endTime || ''
      },
      operationSettings: {
        operatingDays: formData.operatingDays,
        startTime: formData.startTime || '',
        endTime: formData.endTime || '',
        tripInterval: parseNumberOrNull(formData.tripInterval),
        estimatedRouteDuration: parseNumberOrNull(formData.estimatedRouteDuration),
        turnaroundTime: parseNumberOrNull(formData.turnaroundTime),
        notes: formData.notes
      },
      directions: {
        outbound: {
          directionKey: 'OUTBOUND',
          startStopId: formData.startPoint || null,
          endStopId: formData.endPoint || null,
          stops: outboundStops
        },
        inbound: {
          directionKey: 'INBOUND',
          startStopId: formData.endPoint || null,
          endStopId: formData.startPoint || null,
          stops: inboundStops
        }
      },
      stops: buildLegacyStops(outboundStops, inboundStops),
      createdBy: req.session?.userId || null,
      updatedBy: req.session?.userId || null,
      auditLogs
    });

    setFlash(
      req,
      'success',
      intent === 'SUBMIT_REVIEW'
        ? `Đã tạo tuyến "${formData.routeCode}" và chuyển sang Pending Review.`
        : `Đã lưu tuyến "${formData.routeCode}" ở trạng thái Draft.`
    );
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('createRoute error:', err);
    const availableStops = await loadStopsForAdmin().catch(() => []);
    const formData = makeRouteCreateFormData({
      routeCode: req.body.routeCode,
      distance: req.body.distance,
      routeType: req.body.routeType,
      serviceType: req.body.serviceType,
      startPoint: req.body.startPoint,
      endPoint: req.body.endPoint,
      description: req.body.description,
      effectiveDate: req.body.effectiveDate,
      operatingDays: req.body.operatingDays,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      tripInterval: req.body.tripInterval,
      estimatedRouteDuration: req.body.estimatedRouteDuration,
      turnaroundTime: req.body.turnaroundTime,
      notes: req.body.notes,
      outboundStops: normalizeDirectionStops(req.body.outboundStopsJson),
      inboundStops: normalizeDirectionStops(req.body.inboundStopsJson)
    });
    return renderAdmin(req, res, 'admin/route-create', 'Tạo tuyến xe', buildCreatePagePayload(formData, {
      availableStops,
      error: err.code === 11000 ? 'routeCode đã tồn tại.' : 'Có lỗi xảy ra khi tạo tuyến.',
      errors: []
    }));
  }
};

exports.updateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const route = await Route.findById(id);
    if (!route) {
      setFlash(req, 'error', 'Không tìm thấy tuyến cần cập nhật.');
      return res.redirect('/admin/routes');
    }

    const previousStatus = route.status;

    route.routeNumber = safeUpper(req.body.routeNumber || route.routeNumber);
    route.name = clean(req.body.name || route.name);
    route.description = clean(req.body.description || route.description);
    route.distance = parsePositiveNumberOrNull(req.body.distance) ?? route.distance;
    route.monthlyPassPrice = parsePositiveNumberOrNull(req.body.monthlyPassPrice) ?? route.monthlyPassPrice;

    const outboundSequence = normalizeStopSequence(req.body.outboundSequence);
    const inboundSequence = normalizeStopSequence(req.body.inboundSequence);
    const outboundStops = buildDirectionStopsFromSequence(
      outboundSequence,
      route.directions?.outbound?.stops || mapLegacyStopsToView(route.toObject(), 'OUTBOUND')
    );
    const inboundStops = buildDirectionStopsFromSequence(
      inboundSequence,
      route.directions?.inbound?.stops || mapLegacyStopsToView(route.toObject(), 'INBOUND')
    );

    if (outboundSequence.length || inboundSequence.length) {
      const [outboundValidation, inboundValidation] = await Promise.all([
        validateDirection('đi', outboundStops, outboundSequence[0], outboundSequence[outboundSequence.length - 1], { strict: true }),
        validateDirection('về', inboundStops, inboundSequence[0], inboundSequence[inboundSequence.length - 1], { strict: true })
      ]);

      const sequenceErrors = [...outboundValidation.errors, ...inboundValidation.errors];
      if (outboundSequence.length < 2) sequenceErrors.push('Chiều đi phải có ít nhất 2 trạm.');
      if (inboundSequence.length < 2) sequenceErrors.push('Chiều về phải có ít nhất 2 trạm.');
      if (outboundSequence.length && inboundSequence.length) {
        if (String(outboundSequence[0]) !== String(inboundSequence[inboundSequence.length - 1])) {
          sequenceErrors.push('Chiều về phải kết thúc tại điểm đầu của chiều đi.');
        }
        if (String(outboundSequence[outboundSequence.length - 1]) !== String(inboundSequence[0])) {
          sequenceErrors.push('Chiều về phải bắt đầu tại điểm cuối của chiều đi.');
        }
      }

      if (sequenceErrors.length) {
        setFlash(req, 'error', normalizeCreateRouteErrorMessage(sequenceErrors[0]));
        return res.redirect('/admin/routes');
      }

      route.startStopId = outboundSequence[0] || route.startStopId;
      route.endStopId = outboundSequence[outboundSequence.length - 1] || route.endStopId;
      route.directions = {
        outbound: {
          directionKey: 'OUTBOUND',
          startStopId: route.startStopId,
          endStopId: route.endStopId,
          stops: outboundStops
        },
        inbound: {
          directionKey: 'INBOUND',
          startStopId: inboundSequence[0] || route.endStopId,
          endStopId: inboundSequence[inboundSequence.length - 1] || route.startStopId,
          stops: inboundStops
        }
      };
      route.stops = buildLegacyStops(outboundStops, inboundStops);
    }

    const nextStatus = normalizeRouteListStatus(req.body.status);
    if (nextStatus) {
      if (nextStatus === 'INACTIVE' && previousStatus !== 'INACTIVE') {
        const deactivationError = await validateRouteDeactivation(route._id);
        if (deactivationError) {
          setFlash(req, 'error', deactivationError);
          return res.redirect('/admin/routes');
        }
      }
      route.status = nextStatus;
    }

    const startTime = clean(req.body.startTime);
    const endTime = clean(req.body.endTime);
    if (startTime || endTime) {
      // Chỉ validate khi người dùng có nhập cả 2 giờ
      if (!startTime || !endTime) {
        // Nếu chỉ nhập 1 phía thì giữ nguyên operationTime hiện tại (không coi là lỗi)
      } else if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        setFlash(req, 'error', 'Giờ vận hành phải đúng định dạng HH:mm.');
        return res.redirect('/admin/routes');
      } else {
        const startM = toMinutes(startTime);
        const endM = toMinutes(endTime);
        const capM = toMinutes(LAST_OPERATION_END_CAP);
        if (startM == null || endM == null) {
          setFlash(req, 'error', 'Giờ vận hành không hợp lệ.');
          return res.redirect('/admin/routes');
        }
        if (startM >= endM) {
          setFlash(req, 'error', 'Giờ bắt đầu phải sớm hơn giờ kết thúc.');
          return res.redirect('/admin/routes');
        }
        if (endM > capM) {
          setFlash(req, 'error', `Giờ kết thúc không được vượt quá ${LAST_OPERATION_END_CAP}.`);
          return res.redirect('/admin/routes');
        }
        route.operationTime = { start: startTime, end: endTime };
      }
    }

    route.updatedBy = req.session?.userId || null;
    route.auditLogs = [
      ...(Array.isArray(route.auditLogs) ? route.auditLogs : []),
      buildAuditLog({
        action: 'UPDATE_ROUTE',
        fromStatus: previousStatus,
        toStatus: route.status,
        message: 'Cập nhật metadata tuyến từ màn hình danh sách.',
        req
      })
    ];

    await route.save();
    setFlash(req, 'success', `Đã cập nhật tuyến "${route.routeNumber}" thành công.`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('updateRoute error:', err);
    setFlash(req, 'error', err.code === 11000 ? 'Mã tuyến đã tồn tại.' : 'Có lỗi xảy ra khi cập nhật tuyến.');
    return res.redirect('/admin/routes');
  }
};

exports.deactivateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const route = await Route.findById(id);
    if (!route) {
      setFlash(req, 'error', 'Không tìm thấy tuyến để tạm ngưng.');
      return res.redirect('/admin/routes');
    }

    const deactivationError = await validateRouteDeactivation(route._id);
    if (deactivationError) {
      setFlash(req, 'error', deactivationError);
      return res.redirect('/admin/routes');
    }

    const fromStatus = route.status;
    route.status = 'INACTIVE';
    route.updatedBy = req.session?.userId || null;
    route.auditLogs = [
      ...(Array.isArray(route.auditLogs) ? route.auditLogs : []),
      buildAuditLog({
        action: 'DEACTIVATE_ROUTE',
        fromStatus,
        toStatus: 'INACTIVE',
        message: 'Tạm ngưng tuyến từ trang quản lý tuyến.',
        req
      })
    ];

    await route.save();
    setFlash(req, 'success', `Đã tạm ngưng tuyến "${route.routeNumber} - ${route.name}".`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('deactivateRoute error:', err);
    setFlash(req, 'error', 'Không thể tạm ngưng tuyến.');
    return res.redirect('/admin/routes');
  }
};

exports.activateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const route = await Route.findById(id);
    if (!route) {
      setFlash(req, 'error', 'Không tìm thấy tuyến để kích hoạt.');
      return res.redirect('/admin/routes');
    }

    const fromStatus = route.status;
    route.status = 'ACTIVE';
    route.updatedBy = req.session?.userId || null;
    route.auditLogs = [
      ...(Array.isArray(route.auditLogs) ? route.auditLogs : []),
      buildAuditLog({
        action: 'ACTIVATE_ROUTE',
        fromStatus,
        toStatus: 'ACTIVE',
        message: 'Kích hoạt tuyến từ trang quản lý tuyến.',
        req
      })
    ];

    await route.save();
    setFlash(req, 'success', `Đã kích hoạt lại tuyến "${route.routeNumber} - ${route.name}".`);
    return res.redirect('/admin/routes');
  } catch (err) {
    console.error('activateRoute error:', err);
    setFlash(req, 'error', 'Không thể kích hoạt lại tuyến.');
    return res.redirect('/admin/routes');
  }
};
