const path = require('path');
const express = require('express');
const session = require('express-session');

const configViewEngine = (app) => {
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../views'));
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));
    app.use(session({
        secret: 'my_secret_key',
        resave: false,
        saveUninitialized: false
    }));
}
module.exports = configViewEngine;
