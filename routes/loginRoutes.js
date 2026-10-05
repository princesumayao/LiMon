const express = require('express');
const router = express.Router();
const path = require('path');
const { getCurrentUser } = require('../backend/auth');

// Landing on /login (or /) while already holding a valid session cookie
// just re-shows the login form for no reason - send them straight to the
// dashboard instead of asking them to sign in again.
router.get("/", (req, res) => {
    if (getCurrentUser(req)) {
        return res.redirect('/home');
    }
    res.sendFile(path.join(__dirname, '../public/html/login.html'));
});

module.exports = router;