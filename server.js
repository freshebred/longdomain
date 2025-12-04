const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data', 'canvas_data.json');
const JOKE_FILE = path.join(__dirname, 'data', 'dataset.json');

// Rate limiting: Map<IP, timestamp[]>
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 3 * 1000; // 3 seconds
const MAX_REQUESTS = 100000; // High limit as per previous code, but we'll use it for WS messages too

// Bad words regex (basic list + patterns)
const advancedFilter = /((f|ph)[u@*](c|k|q)|s[h$][i1]t|b[i1]tch|wh[o0]re|c[u*]nt|n[i1]gg(er|a)|k[i1]ll|d[i1]e|su[i1]c[i1]de)/i;

function isRateLimited(ip) {
    const now = Date.now();
    let timestamps = rateLimitMap.get(ip) || [];
    // Filter out old timestamps
    timestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);

    if (timestamps.length >= MAX_REQUESTS) {
        return true;
    }

    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    return false;
}

function getRotatedRectCorners(cx, cy, w, h, angleDeg) {
    const angleRad = angleDeg * (Math.PI / 180);
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // Half dimensions (with padding)
    const hw = (w / 2) + 10; // 10px padding
    const hh = (h / 2) + 10;

    // Corners relative to center
    // TL, TR, BR, BL
    const corners = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh }
    ];

    // Rotate and translate
    return corners.map(p => ({
        x: (p.x * cos - p.y * sin) + cx,
        y: (p.x * sin + p.y * cos) + cy
    }));
}

function doPolygonsIntersect(a, b) {
    const polygons = [a, b];

    for (let i = 0; i < polygons.length; i++) {
        const polygon = polygons[i];
        for (let j = 0; j < polygon.length; j++) {
            const p1 = polygon[j];
            const p2 = polygon[(j + 1) % polygon.length];

            // Normal (axis)
            const normal = { x: -(p2.y - p1.y), y: p2.x - p1.x };

            // Project both polygons
            let minA = Infinity, maxA = -Infinity;
            for (const p of a) {
                const projected = normal.x * p.x + normal.y * p.y;
                if (projected < minA) minA = projected;
                if (projected > maxA) maxA = projected;
            }

            let minB = Infinity, maxB = -Infinity;
            for (const p of b) {
                const projected = normal.x * p.x + normal.y * p.y;
                if (projected < minB) minB = projected;
                if (projected > maxB) maxB = projected;
            }

            // Check for gap
            if (maxA < minB || maxB < minA) {
                return false; // Separating axis found
            }
        }
    }
    return true;
}

function checkCollision(newItem, existingItems) {
    // Estimate width based on font size and text length
    // Average char width approx 0.6 * fontSize
    const newW = newItem.text.length * (newItem.fontSize * 0.6);
    const newH = newItem.fontSize;

    const newPoly = getRotatedRectCorners(newItem.x, newItem.y, newW, newH, newItem.rotation);

    for (const item of existingItems) {
        const itemW = item.text.length * (item.fontSize * 0.6);
        const itemH = item.fontSize;

        const itemPoly = getRotatedRectCorners(item.x, item.y, itemW, itemH, item.rotation);

        if (doPolygonsIntersect(newPoly, itemPoly)) {
            return true;
        }
    }
    return false;
}

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients: Map<ws, {ip, viewport: {x, y, w, h, scale}, id}>
const clients = new Map();

function broadcast(data, excludeWs = null) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            client.send(message);
        }
    });
}

function broadcastOnlineCount() {
    const count = wss.clients.size;
    broadcast({ type: 'online_count', count });
}

function broadcastViewports() {
    const viewports = [];
    clients.forEach((data, ws) => {
        if (data.viewport) {
            viewports.push({ id: data.id, ...data.viewport });
        }
    });
    // Broadcast to all, no exclusion needed really, but client can filter self if needed
    // Actually, let's exclude the sender in the loop if we wanted, but for viewports everyone needs to know everyone else
    // We will send all viewports to everyone. Client filters self by ID if needed.
    broadcast({ type: 'viewports', viewports });
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const id = Math.random().toString(36).substr(2, 9);

    clients.set(ws, { ip, id, viewport: null });

    // Send init message with ID
    ws.send(JSON.stringify({ type: 'init', id }));

    broadcastOnlineCount();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'viewport') {
                const clientData = clients.get(ws);
                if (clientData) {
                    clientData.viewport = data.viewport;
                    // We could broadcast immediately or throttle. 
                    // For smoothness, let's broadcast immediately for now, but in high load this should be throttled.
                    broadcastViewports();
                }
            } else if (data.type === 'submit') {
                const clientData = clients.get(ws);
                if (!clientData) return;

                if (isRateLimited(clientData.ip)) {
                    ws.send(JSON.stringify({ type: 'submit_error', error: 'Rate limit exceeded. Chill out.' }));
                    return;
                }

                const { text } = data;

                if (!text || text.length > 67) {
                    ws.send(JSON.stringify({ type: 'submit_error', error: 'Text too long or empty.' }));
                    return;
                }

                if (advancedFilter.test(text)) {
                    ws.send(JSON.stringify({ type: 'submit_error', error: 'Watch your language!' }));
                    return;
                }

                try {
                    const canvasData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

                    let newItem = null;
                    let attempts = 0;
                    const maxAttempts = 5000;

                    while (!newItem && attempts < maxAttempts) {
                        const count = canvasData.length;
                        const gap = 500;
                        let expansion = 0;
                        if (attempts > 100) {
                            expansion = (attempts - 100) * 5;
                        }

                        const maxRadius = 500 + (count * 10) + expansion;
                        const minRadius = Math.max(0, maxRadius - gap);
                        const angle = Math.random() * Math.PI * 2;
                        const r = Math.sqrt(Math.random() * (maxRadius * maxRadius - minRadius * minRadius) + minRadius * minRadius);
                        const x = r * Math.cos(angle);
                        const y = r * Math.sin(angle);
                        const rotation = (Math.random() * 140) - 70;
                        const fontSize = Math.floor(Math.random() * (64 - 24 + 1)) + 24;
                        const COLORS = ['#ff0000', '#008000', '#0000ff', '#800080', '#008080', '#000000', '#ff4500', '#8b4513'];
                        const color = COLORS[Math.floor(Math.random() * COLORS.length)];

                        const candidate = {
                            text,
                            x,
                            y,
                            rotation,
                            fontSize,
                            color,
                            timestamp: Date.now()
                        };

                        if (!checkCollision(candidate, canvasData)) {
                            newItem = candidate;
                        }
                        attempts++;
                    }

                    if (!newItem) {
                        ws.send(JSON.stringify({ type: 'submit_error', error: 'Canvas too crowded near center, try again.' }));
                        return;
                    }

                    canvasData.push(newItem);
                    fs.writeFileSync(DATA_FILE, JSON.stringify(canvasData, null, 2));

                    // Send success to sender
                    ws.send(JSON.stringify({ type: 'submit_success', item: newItem }));

                    // Broadcast new item to everyone else
                    broadcast({ type: 'new_item', item: newItem }, ws);

                } catch (err) {
                    console.error(err);
                    ws.send(JSON.stringify({ type: 'submit_error', error: 'Server error' }));
                }
            }
        } catch (e) {
            console.error('Invalid message', e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcastOnlineCount();
        broadcastViewports(); // Remove their box
    });
});

app.get('/api/data', (req, res) => {
    try {
        const canvasData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const jokeData = JSON.parse(fs.readFileSync(JOKE_FILE, 'utf8'));
        res.json({ canvas: canvasData, jokes: jokeData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read data' });
    }
});

// Removed POST /api/submit as it is now handled via WebSocket

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
