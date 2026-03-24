/**
 * Route Controller
 * Handles route lookup, search, and detailed route data retrieval for the View/Search Routes feature
 */

const { Route, Stop, Schedule } = require('../models/models');
const {
    getFareMatrix,
    estimateSingleRideFare,
    resolveMonthlyPassBasePrice
} = require('../services/fareMatrixService');

/**
 * Get all routes with optional search filter
 * Supports searching by route number or name
 * @route GET /api/public/routes?search=...
 */
const getAllRoutes = async (req, res) => {
    try {
        const searchQuery = req.query.search || '';

        // Build search filter for route number and name
        let filter = { status: 'ACTIVE' };
        if (searchQuery) {
            filter = {
                status: 'ACTIVE',
                $or: [
                    { routeNumber: { $regex: searchQuery, $options: 'i' } },
                    { name: { $regex: searchQuery, $options: 'i' } }
                ]
            };
        }

        const [routes, fareRes] = await Promise.all([
            Route.find(filter)
                .select('_id routeNumber name distance operationTime monthlyPassPrice')
                .limit(50)
                .lean(),
            getFareMatrix()
        ]);

        const matrix = fareRes.matrix;
        const mapped = routes.map(route => ({
            ...route,
            fareInfo: {
                singleRideEstimatedFare: estimateSingleRideFare(Number(route.distance || 0), matrix),
                monthlyPassEffectivePrice: resolveMonthlyPassBasePrice(
                    'SINGLE_ROUTE',
                    Number(route.monthlyPassPrice || 0),
                    matrix
                )
            }
        }));

        res.json({
            success: true,
            data: {
                routes: mapped
            }
        });
    } catch (error) {
        console.error('❌ Error fetching routes:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tải danh sách tuyến xe',
            error: error.message
        });
    }
};

/**
 * Get detailed route data with stops (GeoJSON format)
 * Used for map rendering and displaying route information
 * @route GET /api/public/routes/:routeId
 */
const getRouteDetail = async (req, res) => {
    try {
        const { routeId } = req.params;

        // Fetch route with populated stop details
        const [route, fareRes] = await Promise.all([
            Route.findById(routeId)
                .populate({
                    path: 'stops.stopId',
                    model: 'Stop',
                    select: 'name address lat lng isTerminal location'
                })
                .lean(),
            getFareMatrix()
        ]);

        if (!route || route.status !== 'ACTIVE') {
            return res.status(404).json({
                success: false,
                message: 'Tuyến xe không tồn tại'
            });
        }

        const matrix = fareRes.matrix;
        route.fareInfo = {
            singleRideEstimatedFare: estimateSingleRideFare(Number(route.distance || 0), matrix),
            monthlyPassEffectivePrice: resolveMonthlyPassBasePrice(
                'SINGLE_ROUTE',
                Number(route.monthlyPassPrice || 0),
                matrix
            )
        };

        // Transform stops data to ensure GeoJSON format compatibility
        if (route.stops && Array.isArray(route.stops)) {
            route.stops = route.stops
                .map(stop => {
                    const stopDoc = stop?.stopId && typeof stop.stopId === 'object' ? stop.stopId : null;
                    if (!stopDoc) return null;

                    return {
                        ...stop,
                        stopId: {
                            ...stopDoc,
                            // Fallback for lat/lng if not in GeoJSON format
                            lat: stopDoc.location?.coordinates?.[1] || stopDoc.lat,
                            lng: stopDoc.location?.coordinates?.[0] || stopDoc.lng,
                            location: stopDoc.location || {
                                type: 'Point',
                                coordinates: [stopDoc.lng || 108.206230, stopDoc.lat || 16.047079]
                            }
                        }
                    };
                })
                .filter(Boolean);
        }

        res.json({
            success: true,
            data: route
        });
    } catch (error) {
        console.error('❌ Error fetching route detail:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tải chi tiết tuyến xe',
            error: error.message
        });
    }
};

/**
 * Get route stops with GeoJSON format for map display
 * @route GET /api/public/routes/:routeId/geojson
 */
const getRouteGeoJSON = async (req, res) => {
    try {
        const { routeId } = req.params;

        const route = await Route.findById(routeId)
            .populate('stops.stopId')
            .lean();

        if (!route || route.status !== 'ACTIVE') {
            return res.status(404).json({
                success: false,
                message: 'Tuyến xe không tồn tại'
            });
        }

        // Get unique stops grouped by direction
        const stopsGeometry = {
            type: 'FeatureCollection',
            features: []
        };

        if (route.stops && Array.isArray(route.stops)) {
            const processedStops = new Set();

            route.stops.forEach((stop, index) => {
                if (!stop.stopId) return;

                const stopKey = stop.stopId._id.toString();
                if (processedStops.has(stopKey)) return;
                processedStops.add(stopKey);

                const coords = stop.stopId.location?.coordinates || 
                    [stop.stopId.lng || 108.206230, stop.stopId.lat || 16.047079];

                stopsGeometry.features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: coords
                    },
                    properties: {
                        id: stop.stopId._id,
                        name: stop.stopId.name,
                        address: stop.stopId.address,
                        isTerminal: stop.stopId.isTerminal || false,
                        orderIndex: stop.orderIndex
                    }
                });
            });
        }

        res.json({
            success: true,
            data: stopsGeometry
        });
    } catch (error) {
        console.error('❌ Error fetching route GeoJSON:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tải dữ liệu bản đồ',
            error: error.message
        });
    }
};

function getLoadMeta(schedule) {
    const capacity = Math.max(1, Number(schedule.busId?.capacity || 45));
    const passengerCount = Math.max(0, Number(schedule.passengerCount || 0));
    const occupancyPercentage = Math.min(100, Math.round((passengerCount / capacity) * 100));
    const loadStatus = String(schedule.loadStatus || '').toUpperCase();

    if (loadStatus === 'FULL' || occupancyPercentage >= 90) {
        return { occupancyPercentage, loadColor: '#dc2626' };
    }
    if (loadStatus === 'CROWDED' || occupancyPercentage >= 70) {
        return { occupancyPercentage, loadColor: '#f59e0b' };
    }
    if (loadStatus === 'MODERATE' || occupancyPercentage >= 40) {
        return { occupancyPercentage, loadColor: '#3b82f6' };
    }
    return { occupancyPercentage, loadColor: '#16a34a' };
}

const getRouteLiveVehicles = async (req, res) => {
    try {
        const { routeId } = req.params;
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);

        const schedules = await Schedule.find({
            routeId,
            date: { $gte: start, $lte: end },
            archived: { $ne: true },
            status: { $in: ['SCHEDULED', 'IN_PROGRESS'] }
        })
            .populate('routeId', 'routeNumber name')
            .populate('busId', 'licensePlate capacity')
            .populate('driverId', 'fullName')
            .lean();

        const vehicles = schedules
            .filter((schedule) =>
                Number.isFinite(Number(schedule.currentLocation?.lat)) &&
                Number.isFinite(Number(schedule.currentLocation?.lng))
            )
            .map((schedule) => {
                const { occupancyPercentage, loadColor } = getLoadMeta(schedule);
                return {
                    scheduleId: String(schedule._id),
                    routeId: String(schedule.routeId?._id || routeId),
                    routeNumber: schedule.routeId?.routeNumber || '',
                    routeName: schedule.routeId?.name || '',
                    licensePlate: schedule.busId?.licensePlate || '',
                    capacity: Number(schedule.busId?.capacity || 45),
                    passengerCount: Number(schedule.passengerCount || 0),
                    occupancyPercentage,
                    loadColor,
                    loadStatus: schedule.loadStatus || 'NORMAL',
                    driverName: schedule.driverId?.fullName || '',
                    currentLocation: schedule.currentLocation || null
                };
            })
            .sort((a, b) => new Date(b.currentLocation?.updatedAt || 0) - new Date(a.currentLocation?.updatedAt || 0));

        res.json({
            ok: true,
            vehicles,
            lastUpdatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching live vehicles:', error);
        res.status(500).json({
            ok: false,
            message: 'Lỗi khi tải dữ liệu xe đang chạy',
            vehicles: []
        });
    }
};

module.exports = {
    getAllRoutes,
    getRouteDetail,
    getRouteGeoJSON,
    getRouteLiveVehicles
};
