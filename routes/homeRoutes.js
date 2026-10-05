const express = require('express');
const router = express.Router();
const path = require('path');
const { getCurrentUser } = require('../backend/auth');

// Defense in depth: the SPA itself already checks /api/me and bounces to
// /login if there's no session (see guardAndInitAuth() in index.js), but
// that's a client-side redirect - the page briefly loads first. Checking
// here too means an unauthenticated request for /home never gets the
// dashboard HTML at all, not even for a moment.
router.get("/", (req, res) => {
    if (!getCurrentUser(req)) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, '../public/html/index.html'));
});

module.exports = router;