const express = require('express');
const os = require('os');
const app = express();

const loginRoutes = require('./routes/loginRoutes');
const homeRoutes = require('./routes/homeRoutes');
const seatMapRoutes = require('./routes/seatMapRoutes');
const qrToolRoutes = require('./routes/qrToolRoutes');

app.use(express.static('public'));

app.use('/', loginRoutes);
app.use('/login', loginRoutes);
app.use('/home', homeRoutes);
app.use('/seats', seatMapRoutes);
app.use('/qr-tool', qrToolRoutes);

// Lets the "Share via QR" button build a working URL even when staff
// opened the dashboard as plain "localhost" - the server looks up its
// own LAN-facing IPv4 address(es) instead of trusting whatever hostname
// the browser's address bar happens to show.
//
// Returns every candidate rather than guessing one: a typical dev laptop
// also has virtual adapters (VPN clients, VirtualBox/VMware, Docker,
// Hyper-V) that report as valid non-internal IPv4 addresses too, but
// aren't reachable by another device on the real Wi-Fi. Silently picking
// "the first one" is exactly how a QR code ends up encoding a dead
// address that LOOKS right on this PC but fails for everyone else - so
// real Wi-Fi-shaped adapters are listed first (as a best guess) and
// everything else after, and the UI lets staff see/try more than one.
const VIRTUAL_ADAPTER_HINTS = ['vmware', 'virtualbox', 'vethernet', 'virtual', 'docker', 'hyper-v', 'vpn', 'tailscale', 'zerotier', 'loopback', 'tap-', 'tun'];

function getLanIps() {
    const interfaces = os.networkInterfaces();
    const likely = [];
    const other = [];

    for (const name of Object.keys(interfaces)) {
        const looksVirtual = VIRTUAL_ADAPTER_HINTS.some(hint => name.toLowerCase().includes(hint));
        for (const iface of interfaces[name]) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            (looksVirtual ? other : likely).push({ name, address: iface.address });
        }
    }

    return [...likely, ...other];
}

app.get('/api/server-info', (req, res) => {
    res.json({ lanIps: getLanIps() });
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
})