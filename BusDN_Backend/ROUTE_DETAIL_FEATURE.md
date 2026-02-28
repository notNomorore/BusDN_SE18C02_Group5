# Bus Route Detail Feature - Complete Implementation Guide

## Overview
This document outlines the comprehensive interactive "Bus Route Detail" feature for the BusDN bus tracking application. The feature includes direction awareness, multi-tab navigation, map interaction, and a review system.

---

## 1. UI Structure & Components

### 1.1 Sidebar Layout (35% of screen)
The sidebar has been completely redesigned with a dual-view system:

#### **Search View** (Initial State)
- **Header**: Logo and subtitle
- **Search Section**: Input field + search button
- **Routes List**: Dynamic list of available routes

#### **Detail View** (Appears after route selection)
- **Detail Header**: Route name and route number with back button
- **Direction Toggle**: Two buttons for "Lượt Đi" (Outbound) and "Lượt Về" (Inbound)
- **Sub-tabs Navigation**: Three tabs - Stops, Info, Reviews
- **Tab Content Area**: Dynamic content rendering based on selected tab

### 1.2 Map Section (65% of screen)
- Full-screen Leaflet.js map
- OpenStreetMap tiles as base layer
- Interactive markers for bus stops
- Route visualization via OSRM
- Info panel at bottom-left
- Mobile CTA modal at top-right

---

## 2. Feature Details

### 2.1 Direction Toggle (Lượt Đi & Lượt Về)

**Functionality:**
- Two toggle buttons switch between OUTBOUND and INBOUND routes
- When switched, the following update automatically:
  - Stops list (re-sorted by orderIndex)
  - Map visualization (new markers and polyline)
  - Info tab (start/end stops update)

**Data Handling:**
```javascript
// Returns data in this format:
{
  stops: {
    outbound: [...],    // Filtered and sorted stops for outbound
    inbound: [...],     // Filtered and sorted stops for inbound
    all: [...]          // All stops unsorted
  }
}
```

**Code Reference:**
- Function: `switchDirection(direction)` - Lines ~950
- UI Update: Active button styling, re-render stops and map

---

### 2.2 Sub-Tabs (Trạm Dừng, Thông Tin, Đánh Giá)

#### **Tab 1: Trạm Dừng (Stops Tab)**
**Content:** Vertical timeline list of bus stops
- Each stop shows:
  - Sequential number (1, 2, 3, ...)
  - Stop name (clickable)
  - Estimated arrival time (⏱️)
  - Distance from start (📏)
  
**Visual Design:**
- Vertical line connecting all stops
- Color-coded circles:
  - 🟢 Green for first stop
  - 🔴 Red for last/terminal stop
  - 🟦 Teal for intermediate stops
- Hover effect: background color change and slight translation

**Interactivity:**
- Click any stop → `flyToStop()` animates map to that location
- Smooth flyTo animation (1.5 seconds)
- Popup shows stop name on map

**Code Reference:**
- Function: `renderStops()` - Lines ~965
- Function: `flyToStop(lat, lng, name)` - Lines ~1030
- Styling: `.stops-timeline`, `.stop-item` - Lines 250-320

---

#### **Tab 2: Thông Tin (Info Tab)**
**Content:** 6-card grid displaying route metadata
- Mã tuyến (Route Number)
- Tên tuyến (Route Name)
- Khoảng cách (Distance in km)
- Giờ hoạt động (Operating Hours)
- Điểm đầu (Start Stop)
- Điểm cuối (End Stop)

**Design:**
- 2-column grid (responsive to 1-column on mobile)
- Each card has:
  - Label (uppercase, smaller text)
  - Value (bold, larger text)
  - Left border accent (#0f766e teal)
  - Light background

**Data Source:**
- Values pulled from route object
- Start/End stops extracted from filtered direction stops

**Code Reference:**
- Function: `renderRouteInfo()` - Lines ~1040
- Styling: `.route-info-grid`, `.info-card` - Lines 370-390

---

#### **Tab 3: Đánh Giá (Reviews Tab)**
**Content:** Rating system + review submission + review list

**Review Form:**
- **Star Rating**: 5 interactive stars
  - Click to set rating 1-5
  - Stars highlight on hover and selection
  - Visual feedback with color change (#fbbf24 gold)
  
- **Comment Textarea**:
  - Placeholder: "Chia sẻ trải nghiệm của bạn..."
  - Min height: 80px
  - Resizable
  
- **Submit Button**:
  - Validation: Rating required, comment required
  - Shows success alert: "✅ Cảm ơn bạn đã đánh giá!"
  - Form resets after submission

**Reviews Display:**
- Newly submitted reviews appear at top of list
- Each review shows:
  - Author name
  - Date (formatted as Vietnamese locale)
  - Star rating (★★★★☆)
  - Comment text

**Current Implementation:**
- Client-side storage (localStorage could be added)
- Ready for backend integration
- Reviews persist during session

**Code Reference:**
- Function: `setRating(rating)` - Lines ~1150
- Function: `submitReview()` - Lines ~1160
- Function: `addReviewToList(review)` - Lines ~1190
- Styling: `.review-form`, `.review-item` - Lines 410-450

---

### 2.3 Map Interaction

#### **Route Visualization**
1. **Markers for Stops:**
   - Color-coded circle markers
   - Green (#16a34a) = First stop
   - Red (#dc2626) = Last stop/terminal
   - Teal (#0f766e) = Intermediate stops
   - Clickable to show stop name popup

2. **Polyline Route:**
   - Uses OSRM (Open Source Routing Machine)
   - Fetches actual street route between stops
   - Teal color (#0f766e), 5px width, 0.7 opacity
   - Rounded line joins for smooth appearance

3. **Map Bounds:**
   - Auto-fit to show entire route
   - 50px padding on all sides
   - Smooth transition

**Code Reference:**
- Function: `displayRouteOnMap(route)` - Lines ~1080
- OSRM API: `https://router.project-osrm.org/route/v1/driving/...`

#### **FlyTo Animation**
When clicking a stop:
```javascript
map.flyTo([lat, lng], 16, {
    animate: true,
    duration: 1.5  // seconds
});
```
- Zoom level 16 (street level detail)
- Smooth animation
- Popup opens with stop name

---

### 2.4 Data Flow & API Integration

**API Endpoint:** `/api/public/routes/:id`

**Response Structure:**
```javascript
{
  success: true,
  data: {
    _id: "...",
    routeNumber: "01",
    name: "Route from A to B",
    distance: 15.5,
    operationTime: {
      start: "05:00",
      end: "23:00"
    },
    stops: {
      outbound: [
        {
          stopId: { name, address, location, isTerminal },
          orderIndex: 0,
          direction: "OUTBOUND",
          distanceFromStart: 0,
          estimatedArrivalTime: "05:00"
        },
        ...
      ],
      inbound: [...],
      all: [...]
    }
  }
}
```

**Backwards Compatibility:**
- Supports old format: `route.stops` as array
- Supports new format: `route.stops` with outbound/inbound
- Auto-detection and filtering based on available data

**GeoJSON Location Format:**
```javascript
location: {
  type: "Point",
  coordinates: [longitude, latitude]  // [lng, lat] order
}
```

---

## 3. Styling & Visual Design

### 3.1 Color Scheme
- **Primary Teal**: #0f766e (buttons, accents)
- **Dark Teal**: #134e4a (headers, dark variant)
- **Success Green**: #16a34a (first stop)
- **Danger Red**: #dc2626 (last stop)
- **Neutral**: #f9fafb (light backgrounds), #333 (text)
- **Gold**: #fbbf24 (star ratings)

### 3.2 Typography
- **Font**: Segoe UI, Tahoma, Geneva, Verdana, sans-serif
- **Headings**: Font-weight 700 (bold)
- **Labels**: Uppercase, letter-spacing 0.5px
- **Body**: 13-14px (mobile-friendly)

### 3.3 Responsive Design
- **Desktop** (>1024px): Side-by-side layout (35% sidebar, 65% map)
- **Tablet** (1024px): Stacked layout (40vh sidebar, 60vh map)
- **Mobile** (<768px): 
  - CTA modal hidden
  - Single-column info cards
  - Adjusted padding

---

## 4. State Management

### Global Variables
```javascript
let currentRoute = null;        // Selected route object
let currentDirection = 'OUTBOUND'; // Toggle state
let currentTab = 'stops';       // Active tab
let selectedRating = 0;         // Review star rating
let routeMarkers = [];          // Map markers array
let routes = [];                // List of searched routes
```

### State Transitions
1. **Initial**: searchView visible, empty routes list
2. **Search**: User enters search term, routes list populates
3. **Select Route**: detailView shown, all panels render
4. **Switch Direction**: Re-render stops and map
5. **Switch Tab**: Show relevant tab content
6. **Back to Search**: Clear detail view, reset state

---

## 5. JavaScript Functions Reference

### Core Functions

| Function | Purpose | Lines |
|----------|---------|-------|
| `searchRoutes(isInitial)` | Fetch and display route list | ~820 |
| `selectRoute(routeId)` | Load full route details | ~880 |
| `switchDirection(direction)` | Toggle outbound/inbound | ~950 |
| `switchTab(tabName)` | Change active tab | ~970 |
| `renderStops()` | Display stops timeline | ~985 |
| `renderRouteInfo()` | Populate info cards | ~1040 |
| `flyToStop(lat, lng, name)` | Animate map to stop | ~1030 |
| `displayRouteOnMap(route)` | Draw route & markers | ~1080 |
| `displayRouteInfoPanel(route)` | Show map info panel | ~1130 |
| `clearMapMarkers()` | Remove all map elements | ~1140 |
| `setRating(rating)` | Update star selection | ~1150 |
| `submitReview()` | Validate & add review | ~1160 |
| `addReviewToList(review)` | Insert review to DOM | ~1190 |
| `backToSearch()` | Return to search view | ~1210 |
| `closeCTA()` | Hide CTA modal | ~1215 |

---

## 6. Event Listeners

```javascript
// Routes list item click
.route-item { onclick="selectRoute(...)" }

// Direction buttons
.direction-btn { onclick="switchDirection(...)" }

// Tab navigation
.sub-tab-btn { onclick="switchTab(...)" }

// Stop name click
.stop-item { onclick="flyToStop(...)" }

// Review form inputs
.star { onclick="setRating(...)" }

// Button actions
.review-submit-btn { onclick="submitReview()" }
.back-btn { onclick="backToSearch()" }
.close-cta { onclick="closeCTA()" }

// Keyboard navigation
searchInput { addEventListener("keypress", Enter = searchRoutes) }
```

---

## 7. Browser Requirements

- **Leaflet.js**: v1.9.4 (mapping)
- **OSRM API**: For route polyline (requires internet)
- **ES6+**: Arrow functions, template literals, modern DOM APIs
- **CSS Grid/Flexbox**: For responsive layout

### CDN Dependencies
```html
<!-- Leaflet -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- Routing Machine -->
<link rel="stylesheet" href="https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css" />
<script src="https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.umd.js"></script>

<!-- Polyline Codec -->
<script src="https://unpkg.com/polyline-codec@0.0.9/polyline.js"></script>
```

---

## 8. Future Enhancements

### Suggested Improvements
1. **Backend Review Storage**: Save reviews to MongoDB
2. **User Authentication**: Show actual user names in reviews
3. **Real-time Updates**: WebSocket for live bus positions
4. **Accessibility**: ARIA labels, keyboard navigation (Tab)
5. **Performance**: Virtual scrolling for large stop lists
6. **Offline Support**: Service worker for cached routes
7. **Multiple Languages**: i18n integration
8. **Analytics**: Track user interactions
9. **Mobile App Links**: Dynamically generate deep links
10. **Fare Integration**: Add fare info for each segment

---

## 9. Testing Checklist

- [ ] Search returns correct routes
- [ ] Route selection displays detail view
- [ ] Direction toggle updates immediately
- [ ] Stops render in correct order
- [ ] Map markers appear with correct colors
- [ ] FlyTo animation works smoothly
- [ ] Polyline connects all stops correctly
- [ ] Tab switching updates content
- [ ] Review submission validates input
- [ ] Stars highlight on click
- [ ] Back button returns to search
- [ ] Responsive layout on mobile/tablet
- [ ] No console errors

---

## 10. Performance Notes

- **Initial Load**: ~2-3 API calls (search, route detail, OSRM)
- **Direction Switch**: 1 OSRM API call (cached stops data)
- **FlyTo Animation**: Hardware-accelerated CSS transforms
- **DOM Updates**: Minimal reflow with class adjustments
- **Memory**: Markers cleared on route change to prevent leaks

---

## File Structure

```
BusDN_Backend/views/
├── route-lookup.ejs          (This file - 1241 lines)
│   ├── CSS Styles (230-810 lines)
│   ├── HTML Structure (835-880 lines)
│   └── JavaScript (885-1240 lines)
├── ...other views
```

---

## Support & Maintenance

For issues, improvements, or questions:
- Check browser console for error messages
- Verify API endpoint connectivity
- Ensure coordinates are in [lng, lat] format
- Test with sample route data

---

**Last Updated**: February 2026  
**Version**: 1.0.0 (Initial Release)  
**Status**: Production Ready
