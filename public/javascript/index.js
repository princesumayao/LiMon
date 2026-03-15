'use strict';

// SIDEBAR TOGE
const sidebar = document.querySelector('.sidebar');
const menuBtn = document.getElementById('menu-btn');

function toggleSidebar() {
    sidebar.classList.toggle('collapsed');
    menuBtn.classList.toggle('open');
}

menuBtn.addEventListener('click', toggleSidebar);

// NAVI
const PAGE_TITLES = {
    dashboard: 'Dashboard',
    noise: 'Noise Levels',
    environment: 'Environment',
    occupancy: 'Occupancy',
    alerts: 'Notifications'
};

function navigate(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById('page-' + pageId);
    if (page) page.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (navItem) navItem.classList.add('active');

    document.getElementById('topbar-title').textContent = PAGE_TITLES[pageId] || pageId;

    if (pageId === 'noise') renderNoiseChart();
    if (pageId === 'environment') {
        renderTempChart();
        renderHumidChart();
    }
    if (pageId === 'occupancy') {
        renderOccChart();
        renderOccGauge();
    }
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => navigate(item.dataset.page));
});

// REAL TIME TIKTOKCLOCK
function updateClock() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-PH', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('en-PH', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const liveTime = document.getElementById('live-time');
    const footerTime = document.getElementById('footer-time');

    if (liveTime) liveTime.textContent = `${dateStr}  ·  ${timeStr}`;
    if (footerTime) footerTime.textContent = 'v1.0.0 · AY 2025–2026';
}

updateClock();
setInterval(updateClock, 1000);

// CHARTJS
Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = 'rgba(60,60,67,0.55)';
Chart.defaults.plugins.legend.display = true;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.labels.borderRadius = 3;
Chart.defaults.plugins.legend.labels.useBorderRadius = true;
Chart.defaults.plugins.legend.labels.padding = 14;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(255,255,255,0.96)';
Chart.defaults.plugins.tooltip.titleColor = '#1c1c1e';
Chart.defaults.plugins.tooltip.bodyColor = 'rgba(60,60,67,0.8)';
Chart.defaults.plugins.tooltip.borderColor = 'rgba(60,60,67,0.10)';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.cornerRadius = 10;
Chart.defaults.plugins.tooltip.padding = 10;

// fake data for chartjs
const LABELS_7 = ['7AM', '8AM', '9AM', '10AM', '11AM', '12PM', '1PM', '2PM', '3PM', '4PM', '5PM'];
const TREND_NOISE_TODAY = [41, 43, 48, 52, 62, 54, 51, 54, 49, 46, 44];
const TREND_TEMP_TODAY = [25.2, 25.8, 26.3, 27.0, 27.5, 28.1, 28.4, 28.4, 28.0, 27.6, 27.2];
const TREND_NOISE_WEEK = [44, 50, 55, 48, 60, 52, 47];
const TREND_TEMP_WEEK = [26, 27, 27.5, 28, 28.2, 27.8, 27];

// dashboard trend
const trendCtx = document.getElementById('trendChart').getContext('2d');
const noiseGradient = trendCtx.createLinearGradient(0, 0, 0, 200);
noiseGradient.addColorStop(0, 'rgba(13,33,72,0.12)');
noiseGradient.addColorStop(1, 'rgba(13,33,72,0)');

const tempGradient = trendCtx.createLinearGradient(0, 0, 0, 200);
tempGradient.addColorStop(0, 'rgba(13,50,96,0.08)');
tempGradient.addColorStop(1, 'rgba(13,50,96,0)');

const trendChart = new Chart(trendCtx, {
    type: 'line',
    data: {
        labels: LABELS_7,
        datasets: [
            {
                label: 'Noise (dB)',
                data: TREND_NOISE_TODAY,
                borderColor: 'rgba(13,33,72,0.75)',
                backgroundColor: noiseGradient,
                tension: 0.4,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true,
                borderWidth: 2,
                pointBackgroundColor: 'rgba(13,33,72,0.8)',
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5
            },
            {
                label: 'Temp (°C)',
                data: TREND_TEMP_TODAY,
                borderColor: 'rgba(37,63,122,0.55)',
                backgroundColor: tempGradient,
                tension: 0.4,
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true,
                borderWidth: 2,
                pointBackgroundColor: 'rgba(37,63,122,0.6)',
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5,
                yAxisID: 'y2',
                borderDash: [5, 3]
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
            x: {
                grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                border: { display: false },
                ticks: { padding: 6 }
            },
            y: {
                grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                border: { display: false },
                ticks: { padding: 8 },
                title: { display: true, text: 'dB', font: { size: 10 } }
            },
            y2: {
                position: 'right',
                grid: { display: false },
                border: { display: false },
                ticks: { padding: 8 },
                title: { display: true, text: '°C', font: { size: 10 } }
            }
        },
        plugins: { legend: { position: 'top', align: 'end' } }
    }
});

document.querySelectorAll('.trend-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.trend-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (btn.dataset.set === 'week') {
            trendChart.data.labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            trendChart.data.datasets[0].data = TREND_NOISE_WEEK;
            trendChart.data.datasets[1].data = TREND_TEMP_WEEK;
        } else {
            trendChart.data.labels = LABELS_7;
            trendChart.data.datasets[0].data = TREND_NOISE_TODAY;
            trendChart.data.datasets[1].data = TREND_TEMP_TODAY;
        }
        trendChart.update();
    });
});

// noise chart trend
let noiseChart = null;

function renderNoiseChart() {
    if (noiseChart) return;

    const ctx = document.getElementById('noiseChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, 'rgba(13,33,72,0.12)');
    gradient.addColorStop(1, 'rgba(13,33,72,0)');

    noiseChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: LABELS_7,
            datasets: [
                {
                    label: 'Area A',
                    data: [41, 43, 48, 52, 62, 54, 51, 54, 49, 46, 44],
                    borderColor: 'rgba(13,33,72,0.8)',
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(13,33,72,0.8)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                },
                {
                    label: 'Area B',
                    data: [32, 34, 36, 38, 40, 38, 36, 38, 36, 34, 35],
                    borderColor: 'rgba(37,63,122,0.55)',
                    backgroundColor: 'rgba(37,63,122,0.06)',
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(37,63,122,0.6)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5,
                    borderDash: [5, 3]
                },
                {
                    label: 'Area C',
                    data: [35, 37, 39, 41, 44, 42, 40, 42, 40, 38, 39],
                    borderColor: 'rgba(60,60,67,0.35)',
                    backgroundColor: 'rgba(60,60,67,0.04)',
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(60,60,67,0.45)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5,
                    borderDash: [3, 3]
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    title: { display: true, text: 'dB', font: { size: 10 } }
                }
            },
            plugins: { legend: { position: 'top', align: 'end' } }
        }
    });
}

// temp chart trend
let tempChart = null;

function renderTempChart() {
    if (tempChart) return;

    const ctx = document.getElementById('tempChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, 'rgba(13,33,72,0.12)');
    gradient.addColorStop(1, 'rgba(13,33,72,0)');

    tempChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: LABELS_7,
            datasets: [
                {
                    label: 'Area A',
                    data: [25.2, 25.8, 26.3, 27.0, 27.5, 28.1, 28.4, 28.4, 28.0, 27.6, 27.2],
                    borderColor: 'rgba(13,33,72,0.75)',
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(13,33,72,0.8)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                },
                {
                    label: 'Area B',
                    data: [24.5, 24.8, 25.0, 25.3, 25.8, 26.1, 26.1, 26.0, 25.8, 25.5, 25.2],
                    borderColor: 'rgba(37,63,122,0.5)',
                    backgroundColor: 'rgba(37,63,122,0.05)',
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(37,63,122,0.6)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5,
                    borderDash: [5, 3]
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    title: { display: true, text: '°C', font: { size: 10 } }
                }
            },
            plugins: { legend: { position: 'top', align: 'end' } }
        }
    });
}

// humid chart trend
let humidChart = null;

function renderHumidChart() {
    if (humidChart) return;

    const ctx = document.getElementById('humidChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, 'rgba(13,33,72,0.10)');
    gradient.addColorStop(1, 'rgba(13,33,72,0)');

    humidChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: LABELS_7,
            datasets: [
                {
                    label: 'Area A',
                    data: [58, 59, 61, 63, 64, 62, 62, 62, 61, 60, 60],
                    borderColor: 'rgba(13,33,72,0.72)',
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(13,33,72,0.8)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                },
                {
                    label: 'Area B',
                    data: [55, 56, 57, 58, 59, 58, 58, 58, 57, 56, 56],
                    borderColor: 'rgba(37,63,122,0.5)',
                    backgroundColor: 'rgba(37,63,122,0.05)',
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(37,63,122,0.6)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5,
                    borderDash: [5, 3]
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    title: { display: true, text: '%', font: { size: 10 } }
                }
            },
            plugins: { legend: { position: 'top', align: 'end' } }
        }
    });
}

// occupancy chart trend
let occChart = null;

function renderOccChart() {
    if (occChart) return;

    const ctx = document.getElementById('occChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(13,33,72,0.13)');
    gradient.addColorStop(1, 'rgba(13,33,72,0)');

    occChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: LABELS_7,
            datasets: [
                {
                    label: 'People Inside',
                    data: [0, 5, 12, 22, 31, 35, 37, 37, 36, 34, 32],
                    borderColor: 'rgba(13,33,72,0.8)',
                    backgroundColor: gradient,
                    tension: 0.4,
                    fill: true,
                    borderWidth: 2.5,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: 'rgba(13,33,72,0.85)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1.5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 6 }
                },
                y: {
                    grid: { color: 'rgba(60,60,67,0.06)', drawTicks: false },
                    border: { display: false },
                    ticks: { padding: 8 },
                    max: 60,
                    title: { display: true, text: 'People', font: { size: 10 } }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

// circowl chart for occ
function createGaugeChart(canvasId, current, max) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    const percentage = current / max;

    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            datasets: [{
                data: [percentage, 1 - percentage],
                backgroundColor: ['rgba(13,33,72,0.85)', 'rgba(60,60,67,0.08)'],
                borderWidth: 0,
                borderRadius: [6, 0],
                hoverOffset: 0
            }]
        },
        options: {
            responsive: false,
            cutout: '74%',
            rotation: -90,
            circumference: 360,
            animation: { animateRotate: true, duration: 800, easing: 'easeOutQuart' },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
    });
}

createGaugeChart('gaugeChartDash', 37, 60);

let occGaugeChart = null;

function renderOccGauge() {
    if (occGaugeChart) return;
    occGaugeChart = createGaugeChart('gaugeChartOcc', 37, 60);
}

// Sparklines for ui cards
function createSparkline(canvasId, data) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 40);
    gradient.addColorStop(0, 'rgba(13,33,72,0.10)');
    gradient.addColorStop(1, 'rgba(13,33,72,0)');

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map((_, i) => i),
            datasets: [{
                data,
                borderColor: 'rgba(13,33,72,0.45)',
                backgroundColor: gradient,
                borderWidth: 1.6,
                tension: 0.4,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600, easing: 'easeOutQuart' },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false }
            },
            layout: { padding: 0 }
        }
    });
}

createSparkline('spark-noise', [41, 43, 48, 52, 62, 54, 51, 54, 49, 46, 44]);
createSparkline('spark-temp', [25.2, 25.8, 26.3, 27.0, 27.5, 28.1, 28.4, 28.4, 28.0, 27.6, 27.2]);
createSparkline('spark-humid', [58, 59, 61, 63, 64, 62, 62, 62, 61, 60, 60]);
createSparkline('spark-occ', [0, 5, 12, 22, 31, 35, 37, 37, 36, 34, 32]);


// initialized icon by lucide
function initializeLucideIcons() {
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
        console.log('✓ Lucide icons initialized');
        return true;
    }
    return false;
}

if (!initializeLucideIcons()) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeLucideIcons);
    } else {
        setTimeout(initializeLucideIcons, 100);
    }
}








