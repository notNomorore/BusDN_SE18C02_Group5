const path = require('path');
const express = require('express');

const configViewEngine = (app) => {
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../views'));
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));
}
module.exports = configViewEngine;
