# 🚌 BusDN Backend - Route Management System

## 🎯 Latest Implementation: View/Search Routes

✅ **Status**: Feature Complete (Feb 27, 2026)

### What's New
- Guest-accessible route lookup system with Leaflet.js mapping
- Real-time route search by number or name
- Interactive map display with stop markers and OSRM routing
- Responsive sidebar with direction toggle (OUTBOUND/INBOUND)
- Detail panel with route information, stops list, and reviews tabs

### Quick Links
- 🔗 Access Route Lookup: http://localhost:3000/route-lookup
- 📖 **Full Implementation Details**: See [DEV_LOG.md](./DEV_LOG.md)
- 📡 **API Endpoints**:
  - `GET /api/public/routes` - Search routes
  - `GET /api/public/routes/:routeId` - Get route details

---

## 🏗️ Architecture

```
BusDN_Backend/
├── controllers/
│   ├── authController.js      (User authentication)
│   ├── adminController.js     (Admin features)
│   └── routeController.js     (🆕 Route lookup logic)
├── models/
│   └── models.js              (MongoDB schemas with safety wrappers)
├── routes/
│   ├── webRoutes.js           (Web pages + public APIs)
│   ├── authRoutes.js          (Auth APIs)
│   └── adminRoutes.js         (Admin panel routes)
├── views/
│   ├── route-lookup.ejs       (Route search UI with map)
│   ├── home.ejs               (Homepage)
│   ├── login.ejs              (Authentication)
│   ├── profile.ejs            (User profile)
│   └── admin/                 (Admin templates)
└── config/
    ├── connectdb.js           (MongoDB connection)
    ├── passport.js            (Auth strategy)
    ├── multer.js              (File uploads)
    └── viewEngine.js          (EJS configuration)
```

---

## 📦 Dependencies

**Core Stack**:
- Node.js + Express 5.2.1
- MongoDB + Mongoose 9.1.5
- EJS Templating
- Passport.js (Google OAuth)

**Frontend Libraries** (CDN):
- Leaflet.js 1.9.4 (Interactive maps)
- OpenStreetMap Tiles
- OSRM (Open Source Routing Machine)

---

## 🚀 Getting Started

### Setup
```bash
cd BusDN_Backend
npm install
# Configure .env with MongoDB connection
node Server.js
```

### Access Points
- **Homepage**: http://localhost:3000/home
- **Route Lookup**: http://localhost:3000/route-lookup
- **Admin Panel**: http://localhost:3000/admin/dashboard
- **API Base**: http://localhost:3000/api/public

---

## 📝 Default Admin Account
**Email**: nguyennhatminhnau@gmail.com  
**Role**: ADMIN  
**Purpose**: System administration and route management

---

## 🔒 Security Features

✅ Model Safety: Prevented OverwriteModelError with mongoose model wrapper pattern  
✅ Password Hashing: bcryptjs for secure storage  
✅ Email Verification: OTP-based user account validation  
✅ Session Management: Express-session with secure cookies  
✅ OAuth Integration: Google Sign-In for convenient login  

---

## 🧪 Testing

Run the application and test the route lookup feature:
1. Navigate to `/route-lookup`
2. Search for a route (e.g., "01", "Hạ Long")
3. Click on a route to see it on the map
4. Toggle between directions (Lượt đi / Lượt về)
5. View stops, route info, and reviews

**Note**: This requires sample data in the database. Use `seed.js` to populate test routes.

---

## 📚 Documentation

For detailed implementation context, architecture decisions, and next steps, see:
- **[DEV_LOG.md](./DEV_LOG.md)** - Complete development context and testing checklist

---

## 🔄 Recent Changes

**February 27, 2026 - Route Lookup Implementation**
- ✅ Created `routeController.js` with public APIs
- ✅ Added route-lookup page and endpoints to `webRoutes.js`
- ✅ Fixed model safety issue with mongoose wrapper pattern
- ✅ Verified `route-lookup.ejs` integration with Leaflet.js and OSRM
- ✅ Created comprehensive development log for continuity

---

## 💡 Next Priority Tasks

1. **Seed Sample Data** - Populate database with test routes and stops
2. **Comprehensive Testing** - Validate all features from DEV_LOG checklist
3. **Performance Optimization** - Add caching and query indexes
4. **Mobile App Integration** - Ensure API compatibility with mobile clients
5. **Admin Features** - Build route management UI in admin panel

---

**Last Updated**: February 27, 2026 (✅ Route Lookup Complete)  
**Maintained By**: Full-Stack Development Team  
**Status**: Ready for Testing & Database Population
