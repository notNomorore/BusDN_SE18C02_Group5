/**
 * Route Controller
 * Handles route lookup, search, and detailed route data retrieval for the View/Search Routes feature
 */

const { Route, Stop } = require('../models/models');
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
            route.stops = route.stops.map(stop => ({
                ...stop,
                stopId: {
                    ...stop.stopId,
                    // Fallback for lat/lng if not in GeoJSON format
                    lat: stop.stopId.location?.coordinates?.[1] || stop.stopId.lat,
                    lng: stop.stopId.location?.coordinates?.[0] || stop.stopId.lng,
                    location: stop.stopId.location || {
                        type: 'Point',
                        coordinates: [stop.stopId.lng || 108.206230, stop.stopId.lat || 16.047079]
                    }
                }
            }));
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

module.exports = {
    getAllRoutes,
    getRouteDetail,
    getRouteGeoJSON
};
