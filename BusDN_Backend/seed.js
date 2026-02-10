const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { User, Route, Bus, Stop, Schedule } = require('./models');


mongoose.connect('mongodb://127.0.0.1:27017/BusDN_Demo')
    .then(() => console.log(""))
    .catch(err => console.log(err));

const seedData = async () => {
    await User.deleteMany({});
    await Route.deleteMany({});
    await Bus.deleteMany({});
    await Stop.deleteMany({});
    await Schedule.deleteMany({});

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash("123456", salt); // Mật khẩu chung

    const admin = await User.create({ 
        email: "admin@busdn.vn", 
        password: hashedPassword, 
        fullName: "Ban Quản Lý BusDN", 
        role: "ADMIN", 
        isVerified: true 
    });

    const driver = await User.create({ 
        email: "taixe@busdn.vn", 
        password: hashedPassword, 
        fullName: "Trần Văn Bác Tài", 
        role: "DRIVER", 
        isVerified: true,
        phone: "0905123456"
    });
    const passenger = await User.create({ 
        email: "passenger@busdn.vn", 
        password: hashedPassword, 
        fullName: "Nguyễn Thị Hành Khách", 
        role: "PASSENGER", 
        isVerified: true,
        phone: "0905123432"
    });

    const stops = await Stop.insertMany([
        { name: "Bến xe Kim Liên", address: "Hòa Hiệp Bắc, Liên Chiểu", lat: 16.123, lng: 108.100, isTerminal: true }, // 0
        { name: "Đại học Bách Khoa", address: "54 Nguyễn Lương Bằng", lat: 16.075, lng: 108.150 }, // 1
        { name: "Cầu Rồng (Đuôi cầu)", address: "Đường Nguyễn Văn Linh", lat: 16.060, lng: 108.220 }, // 2
        { name: "Đại học FPT Đà Nẵng", address: "Khu đô thị FPT City", lat: 15.968, lng: 108.260 }, // 3
        { name: "CĐ CNTT Việt - Hàn", address: "Nam Kỳ Khởi Nghĩa", lat: 15.975, lng: 108.255, isTerminal: true } // 4
    ]);

    const routeR16 = await Route.create({
        routeNumber: "R16",
        name: "Kim Liên - CĐ Việt Hàn",
        distance: 30.5,
        operationTime: { start: "05:30", end: "21:00" },
        stops: [

            { stopId: stops[0]._id, orderIndex: 1, direction: "OUTBOUND", distanceFromStart: 0 },
            { stopId: stops[1]._id, orderIndex: 2, direction: "OUTBOUND", distanceFromStart: 5.2 },
            { stopId: stops[2]._id, orderIndex: 3, direction: "OUTBOUND", distanceFromStart: 15.5 },
            { stopId: stops[3]._id, orderIndex: 4, direction: "OUTBOUND", distanceFromStart: 28.0 },
            { stopId: stops[4]._id, orderIndex: 5, direction: "OUTBOUND", distanceFromStart: 30.5 }
        ]
    });

    const bus1 = await Bus.create({ licensePlate: "43B-012.34", brand: "THACO Garden", capacity: 45 });
    const bus2 = await Bus.create({ licensePlate: "43B-056.78", brand: "Daewoo BC095", capacity: 29 });

    await Schedule.create({
        driverId: driver._id,
        busId: bus1._id,
        routeId: routeR16._id,
        date: new Date(), // Hôm nay
        shiftTime: { start: "06:00", end: "14:00" }
    });
    //admin@danabus.vn / 123456
    //taixe@danabus.vn / 123456
    process.exit();
};

seedData();