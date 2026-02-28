# BusDN Route Lookup - Implementation Guide

## 🎯 Overview

This document explains the **Route Selection** mechanism and **Coordinate Handling** for the Bus Route Lookup feature in the BusDN application.

---

## 1. Coordinate Handling

### 1.1 GeoJSON Format (Correct Standard)

The application uses **GeoJSON standard** for storing geographical coordinates. This requires coordinates to be in **[longitude, latitude]** format (NOT [latitude, longitude]).

#### Why is this important?
- **Longitude (X-axis)**: Horizontal position from Prime Meridian (-180 to +180)
- **Latitude (Y-axis)**: Vertical position from Equator (-90 to +90)
- **GeoJSON Standard**: [lng, lat] order

#### Da Nang Range (Verification)
- **Latitude**: 15.8° to 16.2°N
- **Longitude**: 108.05° to 108.35°E

#### Example - Correct Format
```javascript
// ✅ CORRECT - GeoJSON Standard
location: {
    type: 'Point',
    coordinates: [108.206, 16.047]  // [longitude, latitude]
}

// ❌ WRONG - Reverse order
location: {
    type: 'Point',
    coordinates: [16.047, 108.206]  // Would draw "lines to Laos"!
}
```

### 1.2 Database Model Schema

The **Stop** model stores location data using GeoJSON:

```javascript
// Model Definition
{
    _id: ObjectId,
    name: "Stop Name",
    address: "Street Address",
    location: {
        type: 'Point',
        coordinates: [108.206, 16.047]  // [lng, lat]
    },
    isTerminal: true/false
}

// ✅ MongoDB GeoJSON Index
db.stops.createIndex({ "location": "2dsphere" })
```

### 1.3 Frontend Coordinate Extraction

When receiving stop data from the API, the frontend **must extract coordinates correctly**:

```javascript
// From API response (Stop object)
const stop = {
    _id: "...",
    name: "Bến xe Trung tâm",
    location: {
        type: 'Point',
        coordinates: [108.206, 16.047]  // [lng, lat]
    }
};

// ✅ CORRECT extraction for Leaflet
let lng = stop.location.coordinates[0];  // 108.206
let lat = stop.location.coordinates[1];  // 16.047

// Use in Leaflet (which expects [lat, lng])
L.marker([lat, lng]).addTo(map);
L.geoJSON(data, ...).addTo(map);

// ❌ WRONG - Swapped coordinates
let lat = stop.location.coordinates[0];  // WRONG!
let lng = stop.location.coordinates[1];  // WRONG!
```

### 1.4 OSRM API Coordinate Format

The **OSRM (Open Source Routing Machine)** API requires coordinates in **[lon,lat]** format (same as GeoJSON):

```javascript
// Building OSRM request
const coordsForOSRM = [];
stops.forEach(stop => {
    let lng = stop.stopId.location.coordinates[0];  // Extract from GeoJSON
    let lat = stop.stopId.location.coordinates[1];
    coordsForOSRM.push(`${lng},${lat}`);  // Format for OSRM
});

// ✅ CORRECT OSRM URL
const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsForOSRM.join(';')}?overview=full`;
// Example: .../route/v1/driving/108.206,16.047;108.210,16.051...

// ❌ WRONG - swapped coordinates would draw incorrect routes
const wrongUrl = `.../${lat},${lng};...`;  // Lines to Laos!
```

---

## 2. Route Selection Flow

### 2.1 Selection Process Diagram

```
User Input
    ↓
[Sidebar] Search Bar
    ↓
JavaScript: searchRoutes()
    ↓
API: GET /api/public/routes?search=...
    ↓
Database Query: Route.find({ $or: [...] })
    ↓
Return: { success: true, data: [...}, pagination: {...} }
    ↓
Display Results: Create .route-item divs
    ↓
User Clicks Route
    ↓
JavaScript: selectRoute(routeId)
    ↓
API: GET /api/public/routes/{routeId}
    ↓
Database Query: Route.findById(routeId).populate('stops.stopId')
    ↓
Return: { success: true, data: { Route object with stops } }
    ↓
Process Response → displayRouteOnMap(), displayStopsTab()
    ↓
[Map] Shows Markers + Polyline
[Detail Panel] Shows Direction Toggle + Tabs
```

### 2.2 Search Routes Function

```javascript
/**
 * searchRoutes(isInitial = false)
 * 
 * Called when:
 * - User clicks "Tìm Kiếm" button
 * - User presses Enter in search box
 * - Page loads initially (isInitial = true)
 * 
 * Flow:
 * 1. Get search input value from #searchInput
 * 2. Fetch from /api/public/routes?search={value}
 * 3. Parse response (handles multiple response formats)
 * 4. Create HTML for each route
 * 5. Populate #routesList with clickable route-item divs
 */
function searchRoutes(isInitial = false) {
    const searchValue = document.getElementById('searchInput').value.trim();
    const listContainer = document.getElementById('routesList');

    // If not initial load and no search value, show message
    if (!isInitial && !searchValue) {
        listContainer.innerHTML = '<p class="no-results">Vui lòng nhập từ khóa</p>';
        return;
    }

    // Show loading state
    listContainer.innerHTML = '<p class="loading">Đang tải...</p>';

    // Fetch routes from API
    fetch(`/api/public/routes?search=${encodeURIComponent(searchValue)}`)
        .then(res => res.json())
        .then(data => {
            // Handle multiple response formats
            let routes = [];
            if (data.data && data.data.routes) {
                routes = data.data.routes;  // New format with pagination
            } else if (data.data && Array.isArray(data.data)) {
                routes = data.data;         // Middle format
            } else if (Array.isArray(data)) {
                routes = data;              // Old format
            }

            if (!routes || routes.length === 0) {
                listContainer.innerHTML = '<p class="no-results">Không tìm thấy</p>';
                return;
            }

            // Build HTML
            let html = '';
            routes.forEach(route => {
                html += `
                    <div class="route-item" onclick="selectRoute('${route._id}')">
                        <div class="route-number">${route.routeNumber}</div>
                        <div class="route-name">${route.name}</div>
                    </div>
                `;
            });
            listContainer.innerHTML = html;
        })
        .catch(error => {
            console.error('Search error:', error);
            listContainer.innerHTML = '<p class="no-results">Lỗi kết nối</p>';
        });
}
```

### 2.3 Select Route Function

```javascript
/**
 * selectRoute(routeId)
 * 
 * Called when user clicks on a route in the sidebar
 * 
 * Flow:
 * 1. Mark clicked item as active (visual feedback)
 * 2. Fetch full route details from /api/public/routes/{routeId}
 * 3. Store in global currentRoute variable
 * 4. Reset to OUTBOUND direction
 * 5. Clear previous map markers
 * 6. Display detail panel with direction toggle
 * 7. Draw route on map with markers and polyline
 * 8. Populate tabs with stop information
 */
function selectRoute(routeId) {
    // Visual feedback: highlight selected route
    document.querySelectorAll('.route-item').forEach(el => 
        el.classList.remove('active')
    );
    if (event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    }

    // Fetch route details
    fetch(`/api/public/routes/${routeId}`)
        .then(res => res.json())
        .then(resData => {
            // Store in global state
            currentRoute = resData.data || resData;
            currentDirection = 'OUTBOUND';
            
            // Update UI
            clearMapMarkers();
            displayDetailPanel();
            displayRouteOnMap(currentRoute, 'OUTBOUND');
            updateTabs('OUTBOUND');
        })
        .catch(err => {
            alert('Không thể tải chi tiết tuyến');
            console.error(err);
        });
}
```

### 2.4 Direction Toggle Logic

```javascript
/**
 * switchDirection(direction)
 * 
 * Called when user clicks "Lượt đi" or "Lượt về" button
 * 
 * Allows viewing same route with:
 * - OUTBOUND (Lượt đi): A → B path with A→B stops
 * - INBOUND (Lượt về): B → A path with B→A stops
 * 
 * These are stored as separate stop sequences in currentRoute.stops
 */
function switchDirection(direction) {
    currentDirection = direction;
    
    // Update button states
    document.getElementById('outboundBtn').classList.toggle('active', 
        direction === 'OUTBOUND'
    );
    document.getElementById('inboundBtn').classList.toggle('active', 
        direction === 'INBOUND'
    );

    // Redraw map and update tabs
    clearMapMarkers();
    displayRouteOnMap(currentRoute, direction);
    updateTabs(direction);
}

/**
 * getStopsByDirection(route, direction)
 * 
 * Extracts stops for specific direction from route object
 * 
 * Handles both data formats:
 * - New: route.stops = [{ direction: 'OUTBOUND', ... }, ...]
 * - New with groups: route.stops = { outbound: [...], inbound: [...] }
 * 
 * Returns sorted by orderIndex (order in sequence)
 */
function getStopsByDirection(route, direction) {
    if (!route.stops) return [];
    
    if (Array.isArray(route.stops)) {
        // Format: stops = [{direction: 'OUTBOUND', ...}, ...]
        return route.stops
            .filter(s => s.direction === direction)
            .sort((a, b) => a.orderIndex - b.orderIndex);
    }
    
    if (route.stops[direction.toLowerCase()]) {
        // Format: stops = { outbound: [...], inbound: [...] }
        return route.stops[direction.toLowerCase()];
    }
    
    return [];
}
```

### 2.5 Map Display Logic

```javascript
/**
 * displayRouteOnMap(route, direction)
 * 
 * Visualizes route on the map with:
 * 1. Colored circle markers for each stop
 * 2. Polyline from OSRM showing actual streets
 * 3. Fit map bounds to show entire route
 * 
 * CRITICAL: Correct coordinate handling to avoid "Lines to Laos"
 */
function displayRouteOnMap(route, direction) {
    const stops = getStopsByDirection(route, direction);
    if (stops.length === 0) return;

    const coordsForOSRM = [];

    // Step 1: Draw circle markers for each stop
    stops.forEach((stop, index) => {
        const point = stop.stopId;
        if (!point) return;

        // ✅ CORRECT: Extract from GeoJSON format [lng, lat]
        let lat, lng;
        if (point.location && point.location.coordinates) {
            lng = point.location.coordinates[0];  // [0] = longitude
            lat = point.location.coordinates[1];  // [1] = latitude
        } else if (point.lat && point.lng) {
            // Fallback for old format
            lat = point.lat;
            lng = point.lng;
        } else {
            return;  // Skip if no coordinates
        }

        // Color: Green (start), Red (end), Blue (middle)
        const markerColor = index === 0 ? '#28a745' : 
                          (index === stops.length - 1 ? '#dc3545' : '#003366');
        
        // Create marker for Leaflet (expects [lat, lng])
        const marker = L.circleMarker([lat, lng], {
            radius: 8,
            fillColor: markerColor,
            color: "#fff",
            weight: 2.5,
            fillOpacity: 1
        }).bindPopup(`<b>${point.name}</b><br>Trạm ${index + 1}`);

        marker.addTo(map);
        routeMarkers.push(marker);
        
        // Store in OSRM format [lng,lat]
        coordsForOSRM.push(`${lng},${lat}`);
    });

    // Step 2: Get actual street route from OSRM
    if (coordsForOSRM.length >= 2) {
        // ✅ CORRECT: OSRM expects lon,lat format
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsForOSRM.join(';')}?overview=full&geometries=geojson`;

        fetch(osrmUrl)
            .then(res => res.json())
            .then(data => {
                if (data.routes && data.routes[0]) {
                    // OSRM returns GeoJSON, which we can use directly
                    const routeLine = L.geoJSON(data.routes[0].geometry, {
                        style: { color: '#003366', weight: 5, opacity: 0.7 }
                    }).addTo(map);
                    routeMarkers.push(routeLine);

                    // Step 3: Fit map to show entire route
                    map.fitBounds(routeLine.getBounds(), { padding: [100, 100] });
                }
            })
            .catch(err => console.error('OSRM Error:', err));
    }
}
```

---

## 3. Stops Data Structure

### 3.1 Current Format (Used in seed_danang.js)

```javascript
{
    _id: ObjectId,
    routeNumber: "01",
    name: "Route name",
    distance: 8.5,
    operationTime: { start: "05:00", end: "23:00" },
    stops: [
        {
            stopId: ObjectId("..."),  // Reference to Stop document
            orderIndex: 1,             // Position in sequence (1, 2, 3...)
            direction: "OUTBOUND",     // OUTBOUND or INBOUND
            distanceFromStart: 0,
            estimatedArrivalTime: "05:00"
        },
        {
            stopId: ObjectId("..."),
            orderIndex: 2,
            direction: "OUTBOUND",
            distanceFromStart: 0.5,
            estimatedArrivalTime: "05:05"
        },
        // ... more OUTBOUND stops...
        
        // INBOUND stops start here
        {
            stopId: ObjectId("..."),
            orderIndex: 1,
            direction: "INBOUND",
            distanceFromStart: 0,
            estimatedArrivalTime: "18:00"
        },
        // ... more INBOUND stops...
    ]
}
```

### 3.2 Stop Lookup Process

```javascript
// When rendering a route detail:

1. Route is fetched with stops array
2. Each stop in array has stopId (ObjectId)
3. Backend must populate stopId with Stop document
4. Result: { stops: [{ stopId: { _id, name, location: {...} }, ... }] }
5. Frontend extracts location.coordinates[0] = lng, [1] = lat
6. Passes [lat, lng] to Leaflet for rendering
```

---

## 4. Common Issues & Solutions

### Issue #1: "Lines to Laos" Bug

**Symptom**: Polylines draw outside Da Nang area
**Cause**: Coordinates used in wrong order [lat,lng] instead of [lng,lat]

**Solution**:
```javascript
// ❌ WRONG
let lat = coords[0];  // 16.047
let lng = coords[1];  // 108.206
L.geoJSON({coordinates: [lat, lng]})  // GeoJSON won't work

// ✅ RIGHT
let lng = coords[0];  // 108.206
let lat = coords[1];  // 16.047
L.marker([lat, lng])  // [lat, lng] for Leaflet
```

### Issue #2: Stops Not Displaying

**Cause**: 
- stopId not populated by backend
- Coordinates missing or in wrong format
- Filter by wrong direction

**Debug**:
```javascript
// In browser console
fetch('/api/public/routes/{routeId}')
    .then(r => r.json())
    .then(d => {
        console.log('Route stops:', d.data.stops);
        console.log('First stop stopId:', d.data.stops[0].stopId);
        console.log('Location coords:', d.data.stops[0].stopId.location.coordinates);
    });
```

### Issue #3: Direction Toggle Not Working

**Cause**: Stop direction field doesn't match 'OUTBOUND' or 'INBOUND'

**Solution**: Verify seeded data uses exactly these constants:
```javascript
// In seed file, ensure:
direction: "OUTBOUND"  // ✅ Exactly this
direction: "INBOUND"   // ✅ Exactly this

// NOT:
direction: "outbound"  // ❌ Wrong case
direction: "Outbound"  // ❌ Wrong case
```

---

## 5. API Endpoints Reference

### Get All Routes (Search)
```
GET /api/public/routes?search={searchTerm}

Response:
{
    "success": true,
    "data": {
        "routes": [ { _id, routeNumber, name, distance, operationTime, stops: [...] } ],
        "pagination": { page, pages, count, perPage }
    }
}
```

### Get Single Route
```
GET /api/public/routes/{routeId}

Response:
{
    "success": true,
    "data": {
        "_id": "...",
        "routeNumber": "01",
        "name": "Route name",
        "distance": 8.5,
        "operationTime": { "start": "05:00", "end": "23:00" },
        "stops": [
            {
                "_id": "...",
                "stopId": {
                    "_id": "...",
                    "name": "Stop name",
                    "location": {
                        "type": "Point",
                        "coordinates": [108.206, 16.047]  // ✅ [lng, lat]
                    }
                },
                "orderIndex": 1,
                "direction": "OUTBOUND",
                "estimatedArrivalTime": "05:00"
            }
        ]
    }
}
```

---

## 6. Testing Checklist

- [ ] Seeds database with `node seeder/seed_danang.js`
- [ ] Server starts: `node Server.js` (no errors)
- [ ] Search returns results: Type "01" in search box
- [ ] Click route: Detail panel appears with direction toggle
- [ ] Direction toggle: Shows different stops for OUTBOUND/INBOUND
- [ ] Map markers: Display 3 colors (green start, blue middle, red end)
- [ ] Map polyline: Draws within Da Nang bounds (not "to Laos")
- [ ] Stops tab: Lists all stops with estimated times
- [ ] Info tab: Shows route distance, operation hours, direction name
- [ ] Reviews tab: Shows message "No reviews yet"

---

## 7. Key GeoJSON References

- **GeoJSON Spec**: https://tools.ietf.org/html/rfc7946
- **Leaflet Coordinate System**: [latitude, longitude]
- **OSRM Coordinate System**: longitude,latitude
- **MongoDB GeoJSON**: [longitude, latitude]

---

**Last Updated**: February 25, 2026  
**Author**: BusDN Development Team
