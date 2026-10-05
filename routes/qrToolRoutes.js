const express = require('express');
const router = express.Router();
const path = require('path');
const { getCurrentUser } = require('../backend/auth');

// Same reasoning as homeRoutes.js: this is a staff utility (for printing
// the seat-map QR for a poster/Facebook post), not something students
// should stumble onto, so it requires a session even though it isn't
// linked anywhere in the dashboard nav.
router.get("/", (req, res) => {
    if (!getCurrentUser(req)) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../public/html/qr-tool.html'));
});

module.exports = router;
