const express = require('express');
const router = express.Router();
const path = require('path');

// Deliberately no auth check here, unlike homeRoutes.js - this page is
// meant for anyone who scans the QR code, not just logged-in staff.
router.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, '../public/html/seat-map.html'));
});

module.exports = router;
