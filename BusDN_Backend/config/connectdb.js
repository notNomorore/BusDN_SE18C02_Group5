const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
    try {
        const dbURI = "mongodb+srv://DE181046:nhatminh@busdn.2y1qib0.mongodb.net/?appName=BusDN";
        
        if (!dbURI) {
            console.error("❌ Lỗi: MONGODB_URI không tồn tại trong file .env");
            process.exit(1);
        }

        const conn = await mongoose.connect(dbURI);
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;