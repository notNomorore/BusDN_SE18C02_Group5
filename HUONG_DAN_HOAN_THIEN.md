# 📋 KIỂM TRA VÀ HOÀN THIỆN CÁC CHỨC NĂNG

## ✅ CHỨC NĂNG ĐÃ HOÀN THÀNH

### 1. **Đăng ký (Có xác thực email)**
- ✅ Route: `POST /register`
- ✅ Mã hóa password bằng bcrypt
- ✅ Gửi link xác thực email (in console)
- ✅ Route xác thực: `GET /verify/:userId`

### 2. **Đăng nhập**
- ✅ Route: `POST /login`
- ✅ Kiểm tra email xác thực
- ✅ Phân quyền theo role (ADMIN/PASSENGER/DRIVER/ASSISTANT)

### 3. **Đăng nhập Google**
- ✅ Route: `GET /auth/google`
- ✅ Callback: `GET /auth/google/callback`
- ⚠️ **CẦN CẤU HÌNH**: Cần Google OAuth credentials

### 4. **Đăng xuất**
- ✅ Route: `GET /logout`

### 5. **Đổi mật khẩu** ✨ **MỚI THÊM**
- ✅ Route: `GET /change-password` (hiển thị form)
- ✅ Route: `POST /change-password` (xử lý)
- ✅ Xác thực mật khẩu cũ
- ✅ View: `change-password.ejs`

### 6. **Quên mật khẩu** ✨ **HOÀN THIỆN**
- ✅ Route: `GET /forgot-password` (hiển thị form)
- ✅ Route: `POST /forgot-password` (gửi link reset)
- ✅ Route: `GET /reset-password/:userId` (form reset)
- ✅ Route: `POST /reset-password/:userId` (xử lý reset)
- ✅ View: `reset-password.ejs`

### 7. **Đổi ảnh đại diện**
- ✅ Route: `POST /upload-avatar`
- ✅ Upload file bằng Multer

### 8. **Xem profile**
- ✅ Route: `GET /profile`
- ✅ View: `profile.ejs`

### 9. **Edit profile**
- ✅ Route: `POST /edit-profile`
- ✅ Cập nhật fullName

---

## 🔧 CẤU HÌNH GOOGLE OAUTH

### Bước 1: Tạo Google OAuth Credentials
1. Truy cập [Google Cloud Console](https://console.cloud.google.com)
2. Tạo project mới hoặc chọn project hiện có
3. Vào **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth 2.0 Client IDs**
5. Chọn **Web Application**
6. Thêm **Authorized redirect URIs**:
   ```
   http://localhost:3000/auth/google/callback
   ```
7. Copy `Client ID` và `Client Secret`

### Bước 2: Cấu hình trong Server.js
Thay thế trong Server.js (dòng ~45):
```javascript
passport.use(new GoogleStrategy({
    clientID: 'YOUR_GOOGLE_CLIENT_ID',          // ← Thay ở đây
    clientSecret: 'YOUR_GOOGLE_CLIENT_SECRET',  // ← Thay ở đây
    callbackURL: '/auth/google/callback'
}, ...
```

Hoặc dùng `.env`:
```bash
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```

Rồi thêm vào Server.js (yêu cầu `npm install dotenv`):
```javascript
require('dotenv').config();
const clientID = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
```

---

## 📁 DANH SÁCH FILES ĐÃ THÊM/SỬA

### Files Mới:
- ✨ `views/reset-password.ejs` - Form đặt lại mật khẩu
- ✨ `views/change-password.ejs` - Form đổi mật khẩu
- ✨ `.env.example` - Template cấu hình môi trường

### Files Sửa:
- 📝 `Server.js` - Thêm các route mới + Google OAuth
- 📝 `package.json` - Thêm passport packages
- 📝 `views/login.ejs` - Kích hoạt nút Google Login
- 📝 `views/profile.ejs` - Thêm link "Đổi mật khẩu"

---

## 🧪 HƯỚNG DẪN TEST

### 1. Test Đăng ký + Xác thực email:
```
1. Nhấp "Chuyển đổi Đăng nhập / Đăng ký"
2. Nhập Email và Password
3. Nhấp "Đăng Ký"
4. Kiểm tra Console Server → Lấy link /verify/xxx
5. Mở link để xác thực
6. Bây giờ có thể đăng nhập
```

### 2. Test Đổi mật khẩu:
```
1. Đăng nhập
2. Trang Profile → Nhấp "Đổi mật khẩu"
3. Nhập mật khẩu cũ, mật khẩu mới
4. Nhấp "Đổi mật khẩu"
5. Thông báo thành công
```

### 3. Test Quên mật khẩu:
```
1. Trang Login → "Quên mật khẩu?"
2. Nhập Email
3. Kiểm tra Console Server → Lấy link /reset-password/xxx
4. Mở link và nhập mật khẩu mới
```

### 4. Test Đăng nhập Google: 
```
⚠️ Cần cấu hình Google OAuth credentials trước
1. Trang Login → Nhấp "Đăng nhập Google"
2. Đăng nhập tài khoản Google
3. Sẽ tạo tài khoản tự động nếu chưa tồn tại
```

---

## ⚡ CẢI TIẾN THÊM (TÙY CHỌN)

Nếu muốn hoàn thiện hơn nữa, bạn có thể:

### 1. **Thêm validation**
```javascript
// Kiểm tra độ mạnh mật khẩu
if (password.length < 8) {
    return res.render('login', { error: 'Mật khẩu phải ≥ 8 ký tự!' });
}
```

### 2. **Email thực (dùng Nodemailer)**
```bash
npm install nodemailer
```

### 3. **Refresh token cho Google**
```javascript
// Trong googleStrategy callback
if (refreshToken) {
    user.refreshToken = refreshToken;
    await user.save();
}
```

### 4. **2FA (Two-Factor Authentication)**
```bash
npm install speakeasy qrcode
```

---

## 📞 GHI CHÚ QUAN TRỌNG

- 🔐 **Server Secret**: Thay `'my_secret_key'` thành chuỗi bí mật mạnh trong production
- 📧 **Email Server**: Hiện tại chỉ in console, cần kết nối email thực
- 🌐 **Production**: Thay `http://localhost:3000` thành domain thực
- 💾 **Database**: Chắc chắn MongoDB đang chạy `mongod`

---

## 🚀 CHẠY SERVER

```bash
cd e:\SE\ki8\wdp301\code
node Server.js
```

Truy cập: http://localhost:3000/login

---

Chúc bạn thành công! 🎉
