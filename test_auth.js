const mongoose = require('mongoose');

// Helper to delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runTest() {
    try {
        console.log("--- STARTING API TEST ---");

        // Connect to DB to fetch OTP
        await mongoose.connect('mongodb://127.0.0.1:27017/BusDN_Demo');
        const { User } = require('./models');

        const email = `testuser_${Date.now()}@example.com`;
        const password = 'password123';
        const phone = `09${Math.floor(Math.random() * 100000000)}`;

        console.log(`\n1. Registering user: ${email}`);
        let res = await fetch('http://localhost:3000/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Test User',
                email,
                phone,
                password
            })
        });
        let data = await res.json();
        console.log('Response:', data);

        if (res.status !== 201) throw new Error('Registration failed');

        // Fetch OTP from DB
        const user = await User.findOne({ email });
        const otp = user.otp_code;
        console.log(`\n[DB] Retrieved OTP: ${otp}`);

        console.log(`\n2. Verifying OTP`);
        res = await fetch('http://localhost:3000/api/auth/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp })
        });
        data = await res.json();
        console.log('Response:', data);
        if (res.status !== 200) throw new Error('OTP Verification failed');

        console.log(`\n3. Logging in`);
        res = await fetch('http://localhost:3000/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        data = await res.json();
        console.log('Response:', data);
        if (res.status !== 200) throw new Error('Login failed');

        const token = data.token;
        console.log(`\n[Token] ${token.substring(0, 20)}...`);

        console.log(`\n4. Change Password (Protected Route)`);
        const newPassword = 'newPassword456';
        res = await fetch('http://localhost:3000/api/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ oldPassword: password, newPassword })
        });
        data = await res.json();
        console.log('Response:', data);
        if (res.status !== 200) throw new Error('Change Password failed');

        console.log("\n--- TEST COMPLETED SUCCESSFULLY ---");
        process.exit(0);

    } catch (error) {
        console.error("\n❌ TEST FAILED:", error.message);
        process.exit(1);
    }
}

runTest();
