const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const { User } = require('../models/models');
require('dotenv').config();
module.exports = (app) => {
    // --- PASSPORT GOOGLE STRATEGY ---
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET',
        callbackURL: `${backendUrl}/auth/google/callback`
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            let user = await User.findOne({ email: profile.emails[0].value });
            if (!user) {
                const hashedPassword = await bcrypt.hash(`google_${Date.now()}`, await bcrypt.genSalt(10));
                user = new User({
                    email: profile.emails[0].value,
                    fullName: profile.displayName,
                    avatar: profile.photos[0].value,
                    password: hashedPassword,
                    isVerified: true,
                    isFirstLogin: false,
                    role: 'PASSENGER'
                });
                await user.save();
            }
            return done(null, user);
        } catch (err) {
            return done(err, null);
        }
    }));

    passport.serializeUser((user, done) => done(null, user.id));
    passport.deserializeUser(async (id, done) => {
        const user = await User.findById(id);
        done(null, user);
    });

    app.use(passport.initialize());
    app.use(passport.session());
};
