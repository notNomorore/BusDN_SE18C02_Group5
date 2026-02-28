🚍 BusDN Project - AI Context & Developer Guide
File này là nguồn sự thật duy nhất (Single Source of Truth) về cấu trúc dự án, logic nghiệp vụ và dữ liệu cho AI Agent.

🏗️ 1. Technical Core Stack
Backend: Node.js, Express.js.

Database: MongoDB Atlas (Mongoose).

GIS Engine: Leaflet.js + OSRM (Open Source Routing Machine) cho lộ trình thực.

Auth: Session (Web) & JWT (Mobile API).

Frontend: EJS, Bootstrap 5.3, Font Awesome 6.

📂 2. Project Architecture
Plaintext
BusDN_Backend/
├── Server.js             # Entry point & Web Routes
├── models.js             # Centralized Mongoose Schemas
├── seed.js               # Data Seeding Script (Da Nang area)
├── middleware/
│   ├── adminMiddleware.js # Authorization: isAdmin
│   ├── renderAdmin.js    # Layout wrapper cho Admin dashboard
│   └── auth.js           # JWT verification cho Mobile
├── controllers/          # Business Logic
├── views/                # EJS Templates
│   ├── partials/         # Reusable components (header, footer)
│   ├── admin/            # Admin-only views (wrapped in layout.ejs)
│   └── ...               # Passenger views (home, profile, lookup)
└── public/               # Static files (uploads, images, css)
🗄️ 3. Database Models (Centralized)
A. User Model
Roles: PASSENGER, DRIVER, CONDUCTOR, ADMIN.

PriorityProfile: Chứa hồ sơ ưu tiên (PENDING, APPROVED, REJECTED).

Auth: Lưu googleId cho OAuth và isLocked để quản lý tài khoản.

B. GIS Components (Critical)
Stop Schema: * Sử dụng GeoJSON location: { type: "Point", coordinates: [lng, lat] }.

Lưu ý: Tọa độ Đà Nẵng ~ [108.2, 16.0].

Route Schema:

stops: Mảng chứa stopId, orderIndex, và direction (OUTBOUND/INBOUND).

Đường nối phải được vẽ dựa trên orderIndex.

🔐 4. Authentication & Security Flow
Web Access (Session-based)
isAdmin Middleware: Kiểm tra req.session.role === 'ADMIN'.

Guest Access: /login, /register, /tra-cuu (Lookup).

Mobile Access (JWT-based)
Base path: /api/auth/.

Header: Authorization: Bearer <token>.

🗺️ 5. Route Lookup & Mapping Logic (The "BusMap" Implementation)
Khi làm việc với bản đồ và tuyến đường, AI cần tuân thủ:

Coordinate Order: Luôn là [longitude, latitude] trong DB và [latitude, longitude] khi render Leaflet.

Route Rendering:

Bước 1: Xóa layer cũ (map.removeLayer).

Bước 2: Fetch dữ liệu trạm từ /api/public/routes/:id.

Bước 3: Gửi tọa độ trạm đến OSRM API (/driving/lng1,lat1;lng2,lat2...) để lấy đường đi thực tế trên mặt đường.

Bước 4: Vẽ Polyline từ kết quả OSRM.

Interaction: * Sidebar hiển thị danh sách trạm theo timeline dọc.

Click trạm trên sidebar -> map.flyTo([lat, lng], 17).

🛠️ 6. API Endpoints Reference
Public (Không cần Auth)
GET /api/public/routes: Danh sách tuyến (pagination).

GET /api/public/routes/:id: Chi tiết tuyến + Toàn bộ trạm (sorted).

GET /api/public/stops/near: Tìm trạm xung quanh tọa độ hiện tại.

Admin (Cần isAdmin)
POST /admin/staff/create: Tạo tài khoản nhân sự.

POST /admin/staff/toggle-lock/:id: Khóa/Mở khóa tài khoản.

POST /admin/staff/verify-priority/:id: Duyệt hồ sơ ưu tiên.

⚠️ 7. AI Implementation Rules (Dành riêng cho AI)
UI/UX: Sử dụng màu #003366 làm chủ đạo. Text to, rõ ràng, phù hợp người dùng 25-60 tuổi.

Partial Integration: Luôn dùng <%- include('partials/header') %> và <%- include('partials/footer') %>.

Error Handling: Khi render trang Admin, dùng helper renderAdmin() để đảm bảo layout thống nhất.

No Laos Lines: Khi vẽ tuyến, luôn kiểm tra bounds của Đà Nẵng. Nếu vĩ độ < 15 hoặc > 17, tọa độ đang bị sai.