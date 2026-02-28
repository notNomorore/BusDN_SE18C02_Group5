# 📋 Development Context & Migration Log - BusDN View/Search Routes

**Date**: February 27, 2026  
**Feature**: View/Search Routes Implementation - Guest Route Lookup System  
**Status**: ✅ IMPLEMENTATION COMPLETE

---

## 📌 Current State Summary

The Route Lookup system has been successfully implemented with all required components:

### ✅ What Was Just Implemented

1. **Model Safety Enhancement**
   - Wrapped all Mongoose model definitions with `mongoose.models.ModelName || mongoose.model(...)` pattern
   - Prevents `OverwriteModelError` during hot reloads and module reinitializations
   - Applied to: User, Stop, Route, Bus, Schedule models

2. **Route Management Controller** (`controllers/routeController.js`)
   - `getAllRoutes()`: Fetches routes with optional search filtering by route number or name
   - `getRouteDetail()`: Returns complete route data with populated stops (GeoJSON compatible)
   - `getRouteGeoJSON()`: Returns stop coordinates in GeoJSON FeatureCollection format

3. **API Endpoints** (Added to `routes/webRoutes.js`)
   - `GET /route-lookup` - Renders the route lookup page
   - `GET /api/public/routes?search={keyword}` - Search routes by number/name
   - `GET /api/public/routes/{routeId}` - Get detailed route with stops
   - `GET /api/public/routes/{routeId}/geojson` - Get GeoJSON stops data

4. **Frontend UI** (`views/route-lookup.ejs`)
   - **Fixed Header** (80px): BusDN logo, page title, back-to-home button
   - **Split Layout**: 35% Sidebar (search panel) | 65% Leaflet map
   - **Search Functionality**: Real-time JavaScript filtering by route number/name
   - **Interactive Map**: 
     - Leaflet.js with OpenStreetMap tiles
     - OSRM routing for street-level directions
     - Circle markers for stops (green=start, red=end, blue=intermediate)
   - **Detail Panel**: Shows route info, direction toggle (OUTBOUND/INBOUND), tabs for:
     - Stops list with order numbers
     - Route metadata (distance, operating hours)
     - User reviews section
   - **Responsive Design**: Adapts to mobile/tablet screens
   - **Mobile CTA Modal**: Promotes mobile app (App Store/Google Play)

---

## 📁 File Changes Summary

### Created Files
| File | Purpose |
|------|---------|
| `controllers/routeController.js` | Route data retrieval and search logic |
| `DEV_LOG.md` | This development context log |

### Modified Files
| File | Changes |
|------|---------|
| `models/models.js` | Added mongoose model safety wrappers |
| `routes/webRoutes.js` | Added route lookup page route + 3 API endpoints |
| `views/route-lookup.ejs` | Already complete and functional (no changes needed) |

### Unchanged Core Files
- `Server.js` - No additional configuration needed
- `config/` - All configurations working as-is
- `middleware/` - No new middleware required
- `services/` - No service updates needed
- `public/` - Using existing assets

---

## 📦 Dependencies

**No new npm packages added.** All functionality uses existing dependencies:

| Package | Version | Usage |
|---------|---------|-------|
| `mongoose` | ^9.1.5 | Database ORM and model definitions |
| `express` | ^5.2.1 | Web framework and routing |
| `ejs` | ^4.0.1 | Template rendering |
| `leaflet` | (CDN) | Interactive mapping library |
| `osm/osrm` | (3rd-party API) | Street-level routing calculations |

---

## 🔌 Active API Endpoints

### Public Routes (No Authentication Required)
```
GET  /route-lookup                          → Renders route lookup page
GET  /api/public/routes                     → List routes (supports ?search=)
GET  /api/public/routes/:routeId            → Get route details with stops
GET  /api/public/routes/:routeId/geojson    → Get stops in GeoJSON format
```

### Response Format Examples

**GET /api/public/routes?search=01**
```json
{
  "success": true,
  "data": {
    "routes": [
      {
        "_id": "ObjectId",
        "routeNumber": "01",
        "name": "Hạ Long - Đông Phương",
        "distance": 15.5,
        "operationTime": {
          "start": "05:30",
          "end": "22:00"
        }
      }
    ]
  }
}
```

**GET /api/public/routes/{routeId}**
```json
{
  "success": true,
  "data": {
    "_id": "ObjectId",
    "routeNumber": "01",
    "name": "Hạ Long - Đông Phương",
    "distance": 15.5,
    "operationTime": { "start": "05:30", "end": "22:00" },
    "stops": [
      {
        "stopId": {
          "_id": "ObjectId",
          "name": "Bến Tàu Hạ Long",
          "address": "...",
          "lat": 16.xxx,
          "lng": 108.xxx,
          "isTerminal": true,
          "location": { "type": "Point", "coordinates": [108.xxx, 16.xxx] }
        },
        "orderIndex": 1,
        "direction": "OUTBOUND",
        "distanceFromStart": 0
      }
    ]
  }
}
```

---

## 🎯 Technical Implementation Details

### Data Flow Architecture
```
User Input (Sidebar Search)
    ↓
JavaScript Filter (searchRoutes function)
    ↓
GET /api/public/routes?search=...
    ↓
routeController.getAllRoutes()
    ↓
MongoDB Query with Regex Search
    ↓
JSON Response → Displayed in Route List
    ↓
User Clicks Route
    ↓
GET /api/public/routes/{routeId}
    ↓
routeController.getRouteDetail()
    ↓
Populate Stop references with coordinates
    ↓
displayRouteOnMap() function
    ↓
Draw markers + Call OSRM for routing
    ↓
map.fitBounds() to center view
```

### Key Features Breakdown

**Search Functionality**
- Real-time JavaScript filter in sidebar
- Regex-based server search (case-insensitive)
- Supports route number (e.g., "01", "R16") and name matching
- Max 50 results per query

**Map Rendering**
- Base layer: OpenStreetMap tiles
- Stop markers color-coded: Start (🟢), End (🔴), Intermediate (🔵)
- Using CircleMarker with custom styling
- OSRM integration for actual street routing
- Route bounds auto-fit with padding

**Direction Support**
- OUTBOUND (Lượt đi) and INBOUND (Lượt về) routes
- Toggle buttons in detail panel
- Separate stop lists per direction
- Dynamic map updates on toggle

**Responsive Behavior**
- Desktop: Full split layout (35/65)
- Tablet: Stacked layout with reduced heights
- Mobile: Hidden details, CTA modal for app download

---

## 🔐 Security Considerations

✅ **Public Access Design**
- Route lookup is guest-accessible (no authentication)
- Suitable for public route discovery
- No sensitive data exposed
- Search limited to 50 results (prevents abuse)

✅ **Data Validation**
- routeId validated as MongoDB ObjectId
- Search term escaped with `encodeURIComponent()`
- Error handling for missing routes

---

## 🧪 Testing Checklist

### Backend Testing
- [ ] Test `/api/public/routes?search=01` returns matching routes
- [ ] Test `/api/public/routes?search=""` returns all routes
- [ ] Test `/api/public/routes/{invalidId}` returns 404
- [ ] Test `/api/public/routes/{validId}` returns stops with coordinates
- [ ] Verify model definitions don't cause OverwriteModelError on reload

### Frontend Testing
- [ ] Load `/route-lookup` without errors
- [ ] Search displays results in real-time
- [ ] Click route item highlights and loads detail panel
- [ ] Map shows markers for all stops
- [ ] Direction toggle switches between OUTBOUND/INBOUND
- [ ] Tab switching (Stops → Info → Reviews) works
- [ ] Mobile CTA modal displays on desktop correctly
- [ ] Responsive layout works on mobile devices

### Integration Testing
- [ ] End-to-end: Search → Select → Map display
- [ ] OSRM API responsiveness and error handling
- [ ] Leaflet map initialization with default coordinates

---

## 🚀 Next Steps & Continuity

### Immediate Next Phase (Priority Order)

1. **Database Seeding**
   - Load sample routes, stops, and schedules from seed.js
   - Ensure all stops have valid `lat`, `lng`, and `location` (GeoJSON)
   - Verify route samples include multiple directions (OUTBOUND/INBOUND)

2. **Testing & Bug Fixes**
   - Run comprehensive tests from checklist above
   - Handle edge cases (empty database, missing coordinates, etc.)
   - Performance tuning for large route datasets

3. **Enhancement Features**
   - Integrate real user reviews/ratings system
   - Add estimated arrival times (ETA) to stops
   - Implement fare calculation based on distance
   - Add schedule display (next buses, frequencies)

4. **Admin Features**
   - Route management CRUD in admin panel
   - Stop coordinate mapping tool
   - Route schedule assignment interface
   - Analytics dashboard for popular routes

5. **Mobile App Integration**
   - Ensure mobile app uses same API endpoints
   - Add deep linking capability for route sharing
   - offline map caching for common routes

6. **Performance Optimization**
   - Implement route caching strategy
   - Add pagination for large result sets
   - Optimize MongoDB queries with indexes
   - Compress map tiles for mobile devices

---

## 📚 Code Documentation

### routeController.js Function Signatures
```javascript
// Get all routes with optional search filter
getAllRoutes(req, res)
  - Query: ?search={keyword}
  - Returns: { success, data: { routes: [...] } }

// Get detailed route with populated stops
getRouteDetail(req, res)
  - Params: routeId
  - Returns: { success, data: routeObject with stops populated }

// Get route stops in GeoJSON format
getRouteGeoJSON(req, res)
  - Params: routeId
  - Returns: { success, data: FeatureCollection of stops }
```

### Frontend Key Functions (route-lookup.ejs)
```javascript
searchRoutes(isInitial)          // Fetch routes from API
selectRoute(routeId)            // Load route details and map
displayDetailPanel()            // Show route metadata
switchDirection(direction)      // Toggle OUTBOUND/INBOUND
switchTab(tabName)              // Switch between tabs
displayRouteOnMap(route, direction)  // Draw map markers and OSRM route
clearMapMarkers()               // Clean up map display
```

---

## 🔄 State Management Notes

**Session State** (Browser)
- `currentRoute` - Currently selected route object
- `currentDirection` - OUTBOUND or INBOUND
- `routeMarkers[]` - Leaflet markers and layers for cleanup

**Server State**
- Routes fetched fresh on each request (no caching yet)
- MongoDB connections pooled via mongoose

---

## 📞 Support & Debugging

### Common Issues & Solutions

**Issue**: "❌ Lỗi kết nối" (Connection Error)
- Check if API endpoint is returning correct status
- Verify database is connected (`console.log` in Server.js)
- Check browser DevTools Network tab for actual error

**Issue**: Map shows but no route displayed
- Verify route has stops in database
- Check if stops have valid `lat`/`lng` or `location` coordinates
- OSRM API might be down (check https://router.project-osrm.org/)

**Issue**: OverwriteModelError after code reload
- Model safety wrapper in models.js prevents this
- If still occurring, manually clear mongoose cache: `delete require.cache[...]`

---

## 📋 Quick Reference

**Main Entry Points**
- Web UI: `/route-lookup`
- Search API: `/api/public/routes?search=...`
- Detail API: `/api/public/routes/{id}`

**Database Collections Required**
- `users` - User accounts
- `stops` - Bus stop locations
- `routes` - Route definitions
- `buses` - Vehicle fleet
- `schedules` - Service schedules

**External Dependencies**
- OpenStreetMap Tile Server (for base map)
- OSRM (Open Source Routing Machine) for routing calculations

---

**Last Updated**: February 27, 2026  
**Implementation Status**: ✅ Complete and Ready for Testing  
**Maintained By**: Full-stack Development Team
