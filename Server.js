// Server.js
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();

// --- 1. KẾT NỐI MONGODB ---
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://trintde170684:trintde170684@busdn.2y1qib0.mongodb.net/?appName=BusDN";

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Đã kết nối MongoDB Atlas"))
  .catch((err) => console.error("❌ Lỗi kết nối DB:", err));

const models = require("./models");
const { User, Route, Schedule, Bus } = models;

// --- HÀM KIỂM TRA MẬT KHẨU ---
const checkPassword = (password) => {
  if (!password || password.length < 4) return false;
  if (/\s/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[\W_]/.test(password)) return false;
  return true;
};

const PASS_ERR_MSG =
  "Mật khẩu phải có ít nhất 4 ký tự, 1 chữ hoa, 1 số, 1 ký tự đặc biệt và KHÔNG có khoảng trắng!";

// --- 2. CẤU HÌNH GỬI MAIL (NODEMAILER) ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER || "YOUR_GMAIL",
    pass: process.env.MAIL_PASS || "YOUR_GMAIL_APP_PASSWORD",
  },
});

const sendEmail = async (to, subject, htmlContent) => {
  try {
    await transporter.sendMail({
      from: `"BusDN Admin" <${process.env.MAIL_USER || "YOUR_GMAIL"}>`,
      to,
      subject,
      html: htmlContent,
    });
    console.log(`✅ Đã gửi mail tới ${to}`);
  } catch (error) {
    console.error("❌ Lỗi gửi mail:", error);
  }
};

// --- 3. MIDDLEWARE ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "my_secret_key",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Cấu hình Multer upload ảnh
const storage = multer.diskStorage({
  destination: path.join(__dirname, "public/uploads"),
  filename: (req, file, cb) => {
    cb(null, "avatar-" + Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// --- 4. PASSPORT GOOGLE STRATEGY ---
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID",
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET || "YOUR_GOOGLE_CLIENT_SECRET",
      callbackURL: "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ email: profile.emails?.[0]?.value });
        if (!user) {
          user = new User({
            email: profile.emails?.[0]?.value,
            fullName: profile.displayName,
            avatar: profile.photos?.[0]?.value || "/images/default-avatar.png",
            password: "google_oauth",
            isVerified: true,
            role: "PASSENGER",
          });
          await user.save();
        }
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (e) {
    done(e, null);
  }
});

// --- 5. ROUTES CƠ BẢN ---
app.get("/", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  // tuỳ bạn: admin về dashboard, passenger về home
  if (req.session.role === "ADMIN") return res.redirect("/admin/dashboard");
  return res.redirect("/home");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null, success: null });
});

// Google Auth Routes
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  async (req, res) => {
    req.session.userId = req.user._id;
    req.session.role = req.user.role;
    res.redirect("/home");
  }
);

// --- 6. XỬ LÝ ĐĂNG KÝ ---
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!checkPassword(password)) {
      return res.render("login", { error: PASS_ERR_MSG, success: null });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.render("login", { error: "Email đã tồn tại!", success: null });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      email,
      password: hashedPassword,
      role: "PASSENGER",
      fullName: "Hành khách mới",
      isVerified: false,
    });
    await newUser.save();

    const verifyLink = `http://localhost:3000/verify/${newUser._id}`;
    await sendEmail(
      email,
      "Xác thực tài khoản BusDN",
      `<p>Chào mừng!</p><p>Vui lòng bấm link để xác thực: <a href="${verifyLink}">${verifyLink}</a></p>`
    );

    res.render("login", {
      error: null,
      success: "Đăng ký thành công! Vui lòng kiểm tra Email để xác thực.",
    });
  } catch (err) {
    console.error(err);
    res.render("login", { error: "Lỗi hệ thống", success: null });
  }
});

// --- 7. XÁC THỰC & QUÊN MẬT KHẨU ---
app.get("/verify/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.send("<h1>❌ Link không hợp lệ!</h1>");
    if (user.isVerified)
      return res.send(
        '<h1>✅ Đã xác thực rồi! <a href="/login">Đăng nhập</a></h1>'
      );

    await User.findByIdAndUpdate(req.params.userId, { isVerified: true });
    res.send(
      '<h1>✅ Xác thực thành công!</h1><p><a href="/login">Đăng nhập ngay</a></p>'
    );
  } catch (err) {
    res.send("<h1>❌ Lỗi hệ thống!</h1>");
  }
});

app.get("/forgot-password", (req, res) => res.render("forgot-password"));

app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.send(
        '<h1>Đã gửi email khôi phục (Nếu tài khoản tồn tại). <a href="/login">Quay lại</a></h1>'
      );
    }

    const resetLink = `http://localhost:3000/reset-password/${user._id}`;
    await sendEmail(
      email,
      "Khôi phục mật khẩu BusDN",
      `<p>Bấm vào đây để đặt lại mật khẩu: <a href="${resetLink}">${resetLink}</a></p>`
    );

    res.send(
      '<h1>Đã gửi mail hướng dẫn! Kiểm tra hộp thư đến. <a href="/login">Quay lại</a></h1>'
    );
  } catch (err) {
    res.send("<h1>❌ Lỗi hệ thống!</h1>");
  }
});

app.get("/reset-password/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.send("<h1>❌ Link hỏng!</h1>");
    res.render("reset-password", { userId: user._id, error: null });
  } catch (err) {
    res.send("<h1>❌ Lỗi hệ thống!</h1>");
  }
});

app.post("/reset-password/:userId", async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;

    if (!checkPassword(password)) {
      return res.render("reset-password", {
        userId: req.params.userId,
        error: PASS_ERR_MSG,
      });
    }

    if (password !== confirmPassword) {
      return res.render("reset-password", {
        userId: req.params.userId,
        error: "Mật khẩu không khớp!",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    await User.findByIdAndUpdate(req.params.userId, { password: hashedPassword });

    res.send(
      '<h1>✅ Đặt lại mật khẩu thành công! <a href="/login">Đăng nhập</a></h1>'
    );
  } catch (err) {
    res.send("<h1>❌ Lỗi hệ thống!</h1>");
  }
});

// --- 8. ADMIN HELPER & ROUTES ---
const isAdmin = (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  if (req.session.role === "ADMIN") return next();
  return res.redirect("/profile");
};

// ✅ FIX: renderAdmin không còn res.send(err) -> không trả JSON {path: ...}
// đồng thời truyền đủ user/title/path vào view con để tránh EJS lỗi biến undefined
const renderAdmin = async (req, res, view, title, data = {}) => {
  try {
    const currentUser = await User.findById(req.session.userId).lean();
    if (!currentUser) return res.redirect("/login");

    const innerLocals = {
      ...data,
      user: currentUser,
      title,
      path: view.split("/").pop(), // vd: routes, dashboard...
    };

    res.render(view, innerLocals, (err, html) => {
      if (err) {
        console.error("❌ Render inner view error:", err);

        // render layout luôn để khỏi “trắng trang”
        const safeMsg = err.message || "Render error";
        const body = `
          <div class="alert alert-danger">
            <strong>Lỗi render view:</strong> ${safeMsg}
            <div class="small mt-2 text-muted">Hãy xem terminal để biết chi tiết.</div>
          </div>
        `;

        return res.status(500).render("admin/layout", {
          ...innerLocals,
          body,
        });
      }

      return res.render("admin/layout", {
        ...innerLocals,
        body: html,
      });
    });
  } catch (e) {
    console.error("❌ renderAdmin error:", e);
    return res.redirect("/login");
  }
};

// ===== Helpers cho route (tuyến) =====
const parseRoutePayload = (body) => {
  const routeNumber = (body.routeNumber || "").trim().toUpperCase();
  const name = (body.name || "").trim();
  const description = (body.description || "").trim();

  const distanceRaw = String(body.distance ?? "").trim();
  const monthlyPassPriceRaw = String(body.monthlyPassPrice ?? "").trim();

  const startTime = (body.startTime || "").trim();
  const endTime = (body.endTime || "").trim();

  const status =
    (body.status || "ACTIVE").toUpperCase() === "INACTIVE"
      ? "INACTIVE"
      : "ACTIVE";

  return {
    routeNumber,
    name,
    description,
    distanceRaw,
    distance: distanceRaw === "" ? null : Number(distanceRaw),
    monthlyPassPriceRaw,
    monthlyPassPrice:
      monthlyPassPriceRaw === "" ? null : Number(monthlyPassPriceRaw),
    startTime,
    endTime,
    status,
  };
};

const validateRoutePayload = (payload, { requireTime = false } = {}) => {
  const errors = [];

  if (!payload.routeNumber) errors.push("Vui lòng nhập mã tuyến.");
  if (!payload.name) errors.push("Vui lòng nhập tên tuyến.");

  if (
    payload.distanceRaw === "" ||
    Number.isNaN(payload.distance) ||
    payload.distance <= 0
  ) {
    errors.push("Cự ly phải là số lớn hơn 0.");
  }

  if (
    payload.monthlyPassPriceRaw !== "" &&
    payload.monthlyPassPrice !== null &&
    (Number.isNaN(payload.monthlyPassPrice) || payload.monthlyPassPrice < 0)
  ) {
    errors.push("Giá vé tháng phải là số >= 0.");
  }

  const hasStart = !!payload.startTime;
  const hasEnd = !!payload.endTime;

  if (requireTime || hasStart || hasEnd) {
    if (!hasStart || !hasEnd) {
      errors.push("Vui lòng nhập đầy đủ giờ bắt đầu và giờ kết thúc.");
    } else if (payload.startTime >= payload.endTime) {
      errors.push("Giờ kết thúc phải lớn hơn giờ bắt đầu.");
    }
  }

  return errors;
};

const routeListRedirect = (res, type, message) => {
  const q = new URLSearchParams();
  q.set(type, message);
  return res.redirect("/admin/routes?" + q.toString());
};

// ===== Helpers cho schedule =====
const parseSchedulePayload = (body) => {
  const date = body.date ? new Date(body.date) : null;
  const routeId = body.routeId ? body.routeId.trim() : "";
  const busId = body.busId ? body.busId.trim() : "";
  const driverId = body.driverId ? body.driverId.trim() : "";
  const startTime = (body.startTime || "").trim();
  const endTime = (body.endTime || "").trim();
  return { date, routeId, busId, driverId, startTime, endTime };
};

const validateSchedulePayload = (payload) => {
  const errors = [];
  if (!payload.date || isNaN(payload.date.getTime())) errors.push("Vui lòng chọn ngày.");
  if (!payload.routeId) errors.push("Vui lòng chọn tuyến.");
  if (!payload.busId) errors.push("Vui lòng chọn xe.");
  if (!payload.driverId) errors.push("Vui lòng chọn tài xế.");

  if (!payload.startTime || !payload.endTime) {
    errors.push("Vui lòng nhập giờ bắt đầu và kết thúc.");
  } else if (payload.startTime >= payload.endTime) {
    errors.push("Giờ kết thúc phải lớn hơn giờ bắt đầu.");
  }
  return errors;
};

const scheduleListRedirect = (res, date, type, message) => {
  const q = new URLSearchParams();
  if (date) q.set("date", date);
  q.set(type, message);
  return res.redirect("/admin/schedules?" + q.toString());
};

// ===== ADMIN PAGES =====
app.get("/admin/dashboard", isAdmin, (req, res) =>
  renderAdmin(req, res, "admin/dashboard", "Tổng quan")
);

// ✅ FIX: /admin/routes render đúng + có filters
app.get("/admin/routes", isAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const status = (req.query.status || "").trim();

    const filter = {};
    if (q) {
      filter.$or = [
        { routeNumber: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
      ];
    }
    if (status === "ACTIVE" || status === "INACTIVE") {
      filter.status = status;
    }

    const routes = await Route.find(filter)
      .sort({ routeNumber: 1, createdAt: -1 })
      .lean();

    return renderAdmin(req, res, "admin/routes", "Quản lý Tuyến", {
      routes,
      filters: { q, status }, // ✅ routes.ejs dùng filters
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error("❌ Lỗi tải danh sách tuyến:", err);
    return renderAdmin(req, res, "admin/routes", "Quản lý Tuyến", {
      routes: [],
      filters: { q: "", status: "" },
      success: null,
      error: "Không thể tải danh sách tuyến.",
    });
  }
});

app.post("/admin/routes/create", isAdmin, async (req, res) => {
  try {
    const payload = parseRoutePayload(req.body);
    const errors = validateRoutePayload(payload);
    if (errors.length) return routeListRedirect(res, "error", errors[0]);

    const duplicated = await Route.findOne({ routeNumber: payload.routeNumber }).lean();
    if (duplicated) return routeListRedirect(res, "error", "Mã tuyến đã tồn tại.");

    await Route.create({
      routeNumber: payload.routeNumber,
      name: payload.name,
      description: payload.description,
      distance: payload.distance,
      monthlyPassPrice:
        payload.monthlyPassPrice === null || Number.isNaN(payload.monthlyPassPrice)
          ? 200000
          : payload.monthlyPassPrice,
      status: payload.status,
      operationTime:
        payload.startTime && payload.endTime
          ? { start: payload.startTime, end: payload.endTime }
          : { start: "", end: "" },
    });

    return routeListRedirect(res, "success", "Tạo tuyến thành công!");
  } catch (err) {
    console.error("❌ Lỗi tạo tuyến:", err);
    return routeListRedirect(res, "error", "Lỗi hệ thống khi tạo tuyến.");
  }
});

app.post("/admin/routes/:id/update", isAdmin, async (req, res) => {
  try {
    const payload = parseRoutePayload(req.body);
    const errors = validateRoutePayload(payload);
    if (errors.length) return routeListRedirect(res, "error", errors[0]);

    const route = await Route.findById(req.params.id);
    if (!route) return routeListRedirect(res, "error", "Tuyến không tồn tại.");

    const duplicated = await Route.findOne({
      routeNumber: payload.routeNumber,
      _id: { $ne: route._id },
    }).lean();
    if (duplicated) return routeListRedirect(res, "error", "Mã tuyến đã tồn tại.");

    route.routeNumber = payload.routeNumber;
    route.name = payload.name;
    route.description = payload.description;
    route.distance = payload.distance;
    route.status = payload.status;

    route.monthlyPassPrice =
      payload.monthlyPassPrice === null || Number.isNaN(payload.monthlyPassPrice)
        ? 200000
        : payload.monthlyPassPrice;

    route.operationTime =
      payload.startTime && payload.endTime
        ? { start: payload.startTime, end: payload.endTime }
        : { start: "", end: "" };

    await route.save();
    return routeListRedirect(res, "success", "Cập nhật tuyến thành công!");
  } catch (err) {
    console.error("❌ Lỗi cập nhật tuyến:", err);
    return routeListRedirect(res, "error", "Lỗi hệ thống khi cập nhật tuyến.");
  }
});

app.post("/admin/routes/:id/deactivate", isAdmin, async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) return routeListRedirect(res, "error", "Tuyến không tồn tại.");
    if ((route.status || "ACTIVE") === "INACTIVE") {
      return routeListRedirect(res, "error", "Tuyến đã tạm ngưng trước đó.");
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const busySchedule = await Schedule.findOne({
      routeId: route._id,
      date: { $gte: startOfToday },
    }).lean();

    if (busySchedule) {
      return routeListRedirect(
        res,
        "error",
        "Không thể tạm ngưng: tuyến đang có lịch chạy hiện tại/sắp tới."
      );
    }

    route.status = "INACTIVE";
    await route.save();
    return routeListRedirect(res, "success", "Tạm ngưng tuyến thành công!");
  } catch (err) {
    console.error("❌ Lỗi tạm ngưng tuyến:", err);
    return routeListRedirect(res, "error", "Lỗi hệ thống khi tạm ngưng tuyến.");
  }
});

app.post("/admin/routes/:id/activate", isAdmin, async (req, res) => {
  try {
    const route = await Route.findById(req.params.id);
    if (!route) return routeListRedirect(res, "error", "Tuyến không tồn tại.");

    if ((route.status || "ACTIVE") === "ACTIVE") {
      return routeListRedirect(res, "error", "Tuyến đang hoạt động.");
    }

    route.status = "ACTIVE";
    await route.save();

    return routeListRedirect(res, "success", "Kích hoạt lại tuyến thành công!");
  } catch (err) {
    console.error("❌ Lỗi kích hoạt lại tuyến:", err);
    return routeListRedirect(res, "error", "Lỗi hệ thống khi kích hoạt lại tuyến.");
  }
});

app.get("/admin/schedules", isAdmin, async (req, res) => {
  try {
    let selectedDate = req.query.date ? new Date(req.query.date) : new Date();
    selectedDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(selectedDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const schedules = await Schedule.find({
      date: { $gte: selectedDate, $lt: nextDay },
    })
      .populate("routeId")
      .populate("busId")
      .populate("driverId");

    const routes = await Route.find({ status: "ACTIVE" }).sort({ routeNumber: 1 }).lean();
    const buses = await Bus.find({}).lean();
    const drivers = await User.find({ role: "DRIVER" }).lean();

    return renderAdmin(req, res, "admin/schedules", "Điều phối Lịch", {
      schedules,
      routes,
      buses,
      drivers,
      selectedDate: selectedDate.toISOString().slice(0, 10),
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    console.error("❌ Lỗi tải lịch chạy:", err);
    return renderAdmin(req, res, "admin/schedules", "Điều phối Lịch", {
      schedules: [],
      routes: [],
      buses: [],
      drivers: [],
      selectedDate: new Date().toISOString().slice(0, 10),
      success: null,
      error: "Không thể tải lịch.",
    });
  }
});

app.post("/admin/schedules/create", isAdmin, async (req, res) => {
  try {
    const payload = parseSchedulePayload(req.body);
    const errors = validateSchedulePayload(payload);
    if (errors.length) return scheduleListRedirect(res, req.body.date, "error", errors[0]);

    const conflict = await Schedule.findOne({
      date: payload.date,
      $or: [{ busId: payload.busId }, { driverId: payload.driverId }],
    }).lean();

    if (conflict) {
      return scheduleListRedirect(res, req.body.date, "error", "Xe hoặc tài xế đã có lịch trong cùng ngày.");
    }

    await Schedule.create({
      driverId: payload.driverId,
      busId: payload.busId,
      routeId: payload.routeId,
      date: payload.date,
      shiftTime: { start: payload.startTime, end: payload.endTime },
    });

    return scheduleListRedirect(res, req.body.date, "success", "Tạo lịch thành công!");
  } catch (err) {
    console.error("❌ Lỗi tạo lịch:", err);
    return scheduleListRedirect(res, req.body.date, "error", "Lỗi hệ thống khi tạo lịch.");
  }
});

app.get("/admin/profile", isAdmin, async (req, res) => {
  const user = await User.findById(req.session.userId).lean();
  renderAdmin(req, res, "admin/profile", "Hồ sơ Admin", { user });
});

// --- 9. XỬ LÝ ĐĂNG NHẬP & PROFILE ---
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render("login", { error: "Sai email hoặc mật khẩu!", success: null });
    }
    if (!user.isVerified) {
      return res.render("login", { error: "Tài khoản chưa xác thực email!", success: null });
    }

    req.session.userId = user._id;
    req.session.role = user.role;

    if (user.role === "ADMIN") return res.redirect("/admin/dashboard");
    if (user.role === "PASSENGER") return res.redirect("/home");
    return res.redirect("/profile");
  } catch (err) {
    res.render("login", { error: "Lỗi hệ thống", success: null });
  }
});

app.get("/profile", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const user = await User.findById(req.session.userId).lean();

  const error = req.query.error || null;
  const success = req.query.success || null;

  res.render("profile", { user, error, success });
});

app.post("/upload-avatar", upload.single("avatar"), async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");

  if (req.file) {
    await User.findByIdAndUpdate(req.session.userId, {
      avatar: "/uploads/" + req.file.filename,
    });
  }

  if (req.session.role === "ADMIN") return res.redirect("/admin/profile");
  return res.redirect("/profile");
});

app.post("/edit-profile", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");

  await User.findByIdAndUpdate(req.session.userId, {
    fullName: req.body.fullName,
    phone: req.body.phone,
  });

  if (req.session.role === "ADMIN") return res.redirect("/admin/profile");
  if (req.session.role === "PASSENGER") return res.redirect("/home");
  return res.redirect("/profile");
});

app.post("/change-password", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");

  const { oldPassword, newPassword, confirmPassword } = req.body;
  const user = await User.findById(req.session.userId);

  if (!checkPassword(newPassword)) {
    return res.redirect("/profile?error=" + encodeURIComponent(PASS_ERR_MSG));
  }

  if (newPassword !== confirmPassword) {
    return res.redirect("/profile?error=" + encodeURIComponent("Mật khẩu mới không khớp!"));
  }

  if (!(await bcrypt.compare(oldPassword, user.password))) {
    return res.redirect("/profile?error=" + encodeURIComponent("Mật khẩu cũ không đúng!"));
  }

  const hashedPassword = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
  await User.findByIdAndUpdate(req.session.userId, { password: hashedPassword });

  return res.redirect("/profile?success=" + encodeURIComponent("Đổi mật khẩu thành công!"));
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/home", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const user = await User.findById(req.session.userId).lean();
  res.render("home", { user });
});

// --- 10. API MOBILE & ROUTERS ---
const authRoutes = require("./routes/authRoutes");
app.use("/api/auth", authRoutes);

// ✅ PASSENGER ROUTES (UC13: /passenger/wallet/deposit)
const passengerRoutes = require("./routes/passengerRoutes");
app.use("/passenger", passengerRoutes);

// test nhanh
app.get("/__test_server", (req, res) => {
  res.send("Server.js is running OK");
});

// --- 11. KHỞI ĐỘNG ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server chạy tại: http://localhost:${PORT}`));