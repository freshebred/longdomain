require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB ──────────────────────────────────────────────────────────────────

mongoose.connect(process.env.DB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// Canvas Item Schema
const canvasItemSchema = new mongoose.Schema({
    text: String,
    x: Number,
    y: Number,
    rotation: Number,
    fontSize: Number,
    color: String,
    timestamp: Number
});
const CanvasItem = mongoose.model('CanvasItem', canvasItemSchema);

// Question Schema
const questionSchema = new mongoose.Schema({
    _id: { type: String, default: () => uuidv4() },
    question: { type: String, required: true },
    size: { type: Number, default: 500, min: 100, max: 1000 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    x: Number,
    y: Number,
    expiresAt: { type: Date, default: null },
    responses: [{
        _id: { type: String, default: () => uuidv4() },
        text: String,
        x: Number,
        y: Number,
        fontSize: Number,
        rotation: Number,
        timestamp: Number
    }],
    timestamp: { type: Number, default: () => Date.now() }
});
const Question = mongoose.model('Question', questionSchema);

// Maze Session Schema
const mazeSessionSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true },
    path: { type: [String], default: [] },
    unlocked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 3600 } // 1hr TTL
});
const MazeSession = mongoose.model('MazeSession', mazeSessionSchema);

// ─── Static files ─────────────────────────────────────────────────────────────

// Serve maze/admin pages before static so we can intercept specific paths
const DATA_FILE = path.join(__dirname, 'data', 'canvas_data.json');
const JOKE_FILE = path.join(__dirname, 'data', 'dataset.json');

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 3 * 1000;
const MAX_REQUESTS = 100000;

function isRateLimited(ip) {
    const now = Date.now();
    let timestamps = rateLimitMap.get(ip) || [];
    timestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (timestamps.length >= MAX_REQUESTS) return true;
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    return false;
}

// ─── Bad word filter ──────────────────────────────────────────────────────────

const advancedFilter = /((f|ph)[u@*](c|k|q)|s[h$][i1]t|b[i1]tch|wh[o0]re|c[u*]nt|n[i1]gg(er|a)|k[i1]ll|d[i1]e|su[i1]c[i1]de)/i;

// ─── Collision Detection ──────────────────────────────────────────────────────

function getRotatedRectCorners(cx, cy, w, h, angleDeg) {
    const angleRad = angleDeg * (Math.PI / 180);
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const hw = (w / 2) + 10;
    const hh = (h / 2) + 10;
    const corners = [
        { x: -hw, y: -hh }, { x: hw, y: -hh },
        { x: hw, y: hh }, { x: -hw, y: hh }
    ];
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
            const normal = { x: -(p2.y - p1.y), y: p2.x - p1.x };
            let minA = Infinity, maxA = -Infinity;
            for (const p of a) {
                const proj = normal.x * p.x + normal.y * p.y;
                if (proj < minA) minA = proj;
                if (proj > maxA) maxA = proj;
            }
            let minB = Infinity, maxB = -Infinity;
            for (const p of b) {
                const proj = normal.x * p.x + normal.y * p.y;
                if (proj < minB) minB = proj;
                if (proj > maxB) maxB = proj;
            }
            if (maxA < minB || maxB < minA) return false;
        }
    }
    return true;
}

function checkCollision(newItem, existingItems, questions = []) {
    const newW = newItem.text.length * (newItem.fontSize * 0.6);
    const newH = newItem.fontSize;
    const newPoly = getRotatedRectCorners(newItem.x, newItem.y, newW, newH, newItem.rotation);
    
    // 1. Check against other text items
    for (const item of existingItems) {
        const itemW = item.text.length * (item.fontSize * 0.6);
        const itemH = item.fontSize;
        const itemPoly = getRotatedRectCorners(item.x, item.y, itemW, itemH, item.rotation);
        if (doPolygonsIntersect(newPoly, itemPoly)) return true;
    }
    
    // 2. Check against question circles
    for (const q of questions) {
        const radius = q.size / 2;
        // Bounding box center check (with 50px extra padding)
        const dx = newItem.x - q.x;
        const dy = newItem.y - q.y;
        if (Math.sqrt(dx*dx + dy*dy) < radius + 50) return true;
        // Corner checks
        for (const p of newPoly) {
            const pcx = p.x - q.x;
            const pcy = p.y - q.y;
            if (Math.sqrt(pcx*pcx + pcy*pcy) < radius + 10) return true;
        }
    }
    return false;
}

// ─── Question packing helpers ─────────────────────────────────────────────────

const AVERAGE_RESPONSE_FONT_SIZE = 24;
const MAX_RESPONSE_CHARS = 25;

/**
 * Attempts to find a non-overlapping position for a response inside the question circle.
 * The response must fit mostly inside the circle (center within radius - margin).
 */
function findResponsePosition(question, responseText, fontSize = AVERAGE_RESPONSE_FONT_SIZE) {
    const radius = question.size / 2;
    // Reserve top area for question text (approx 60px)
    const topMargin = 70;
    const textW = responseText.length * (fontSize * 0.6);
    const textH = fontSize * 1.4;
    const maxAttempts = 2000;
    const safeRadius = radius + 35; // allow text to gently spill up to 35px over the edge of the circle

    const existingRects = question.responses.map(r => ({
        x: r.x, y: r.y,
        text: r.text,
        fontSize: r.fontSize || AVERAGE_RESPONSE_FONT_SIZE,
        rotation: r.rotation || 0
    }));

    for (let i = 0; i < maxAttempts; i++) {
        // Random angle, but bias toward lower half (avoid top question text area)
        const angle = Math.random() * Math.PI * 2;
        const maxR = safeRadius - Math.max(textW, textH) / 2;
        if (maxR <= 0) return null;
        const r = Math.sqrt(Math.random()) * maxR;
        let cx = r * Math.cos(angle);
        let cy = r * Math.sin(angle);

        // Push away from top reserved area
        if (cy < -radius + topMargin) {
            cy = -radius + topMargin + Math.abs(cy) * 0.3;
        }

        const candidate = {
            x: cx, y: cy,
            text: responseText,
            fontSize: fontSize,
            rotation: 0
        };

        if (!checkCollision(candidate, existingRects)) {
            return { x: cx, y: cy };
        }
    }
    return null; // circle full
}

/**
 * Estimates whether one more response can fit in the circle.
 */
function canFitMoreResponse(question) {
    const dummy = { question: question.question, size: question.size, responses: question.responses };
    const testText = 'a'.repeat(MAX_RESPONSE_CHARS);
    return findResponsePosition(dummy, testText) !== null;
}

// ─── Question placement on world canvas ───────────────────────────────────────

/**
 * Picks a world coordinate just outside the existing item cluster,
 * ensuring no overlap with any canvas item or other question circle.
 *
 * Strategy: measure the actual furthest reach of existing content,
 * then search in an annular band just beyond that edge.
 */
async function findQuestionPlacement(size) {
    const radius = size / 2;
    const canvasItems = await CanvasItem.find({}, 'x y fontSize text').lean();
    const questions = await Question.find({}, 'x y size').lean();

    // Build exclusion zones for collision checking
    const exclusionZones = [
        ...canvasItems.map(item => ({
            x: item.x, y: item.y,
            r: Math.max((item.text || '').length * (item.fontSize || 32) * 0.6, 80)
        })),
        ...questions.map(q => ({ x: q.x, y: q.y, r: q.size / 2 + 150 }))
    ];

    // Measure the actual reach of the mainland: furthest item edge from origin
    let clusterRadius = 200; // minimum — never go below this even if canvas is empty
    for (const zone of exclusionZones) {
        const dist = Math.sqrt(zone.x * zone.x + zone.y * zone.y) + zone.r;
        if (dist > clusterRadius) clusterRadius = dist;
    }

    // Try placing just outside the cluster edge, up to 800px further
    const GAP_MIN = radius + 200;   // minimum clearance beyond cluster edge
    const GAP_MAX = radius + 800;   // maximum scan distance beyond cluster edge
    const maxAttempts = 600;

    for (let i = 0; i < maxAttempts; i++) {
        const angle = Math.random() * Math.PI * 2;
        // Uniformly sample distance in the band [clusterRadius+GAP_MIN, clusterRadius+GAP_MAX]
        const minR = clusterRadius + GAP_MIN;
        const maxR = clusterRadius + GAP_MAX;
        const dist = minR + Math.random() * (maxR - minR);
        const cx = dist * Math.cos(angle);
        const cy = dist * Math.sin(angle);

        let conflict = false;
        for (const zone of exclusionZones) {
            const dx = cx - zone.x;
            const dy = cy - zone.y;
            // Required separation: new circle radius + exclusion zone radius + padding
            const minSep = radius + zone.r + 120;
            if (Math.sqrt(dx * dx + dy * dy) < minSep) {
                conflict = true;
                break;
            }
        }
        if (!conflict) return { x: cx, y: cy };
    }

    // Fallback: place at cluster edge + GAP_MIN in a random direction
    const fallbackAngle = Math.random() * Math.PI * 2;
    const fallbackDist = clusterRadius + GAP_MIN;
    return { x: fallbackDist * Math.cos(fallbackAngle), y: fallbackDist * Math.sin(fallbackAngle) };
}

// ─── Maze Logic ───────────────────────────────────────────────────────────────

const MAZE_SECRET = 'iloveyou';
const MAZE_BASE = '/youdontknowthispage';
const ADMIN_PATH = `${MAZE_BASE}/i/l/o/v/e/y/o/u`;

async function getMazeSession(req) {
    const token = req.cookies && req.cookies.maze_session;
    if (!token) return null;
    return await MazeSession.findOne({ token });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve maze entry page
app.get('/youdontknowthispage.html', async (req, res) => {
    // Create a new session
    const token = uuidv4();
    await MazeSession.create({ token, path: [], unlocked: false });
    res.cookie('maze_session', token, { httpOnly: true, maxAge: 3600000, sameSite: 'lax', path: '/' });
    res.sendFile(path.join(__dirname, 'public', 'maze.html'));
});

// Validate and serve maze level pages
app.get(`${MAZE_BASE}/*`, async (req, res) => {
    const fullPath = req.path; // e.g. /youdontknowthispage/i/l/o
    const segments = fullPath.replace(MAZE_BASE + '/', '').split('/').filter(Boolean);

    // Admin panel: check unlocked
    if (fullPath === ADMIN_PATH || fullPath === ADMIN_PATH + '.html' || fullPath === ADMIN_PATH + '/') {
        const session = await getMazeSession(req);
        if (!session || !session.unlocked) {
            return res.redirect('/youdontknowthispage.html');
        }
        return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    }

    // Regular maze level: validate session has progressed to this point
    const session = await getMazeSession(req);
    if (!session) return res.redirect('/youdontknowthispage.html');

    // The user's current legitimate depth is session.path.length
    // They can only be AT the page that is session.path.length deep
    if (segments.length !== session.path.length) {
        return res.redirect('/youdontknowthispage.html');
    }

    // Also verify each segment matches stored path
    for (let i = 0; i < segments.length; i++) {
        if (segments[i].toLowerCase() !== session.path[i]) {
            return res.redirect('/youdontknowthispage.html');
        }
    }

    res.sendFile(path.join(__dirname, 'public', 'maze.html'));
});

// Maze: advance one level
app.post('/api/maze/next', async (req, res) => {
    const session = await getMazeSession(req);
    if (!session) return res.json({ error: 'no_session', redirect: '/youdontknowthispage.html' });

    const { letter } = req.body;
    if (!letter || letter.length !== 1 || !/[a-z]/i.test(letter)) {
        return res.json({ error: 'invalid_letter' });
    }

    const lc = letter.toLowerCase();
    const newPath = [...session.path, lc];

    // Check if the full path now matches the secret
    const isWin = newPath.join('') === MAZE_SECRET;

    session.path = newPath;
    session.unlocked = isWin;
    await session.save();

    if (isWin) {
        return res.json({ success: true, redirect: ADMIN_PATH });
    }

    const nextUrl = `${MAZE_BASE}/${newPath.join('/')}`;
    res.json({ success: true, redirect: nextUrl });
});

// Maze: get current state
app.get('/api/maze/state', async (req, res) => {
    const session = await getMazeSession(req);
    if (!session) return res.json({ depth: 0, path: [] });
    res.json({ depth: session.path.length, path: session.path });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
    try {
        const session = await getMazeSession(req);
        if (!session || !session.unlocked) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        next();
    } catch (err) {
        console.error('requireAdmin error:', err);
        res.status(500).json({ error: 'Server error' });
    }
}

// Check if current user is admin (for canvas admin mode)
app.get('/api/admin/check', async (req, res) => {
    try {
        const session = await getMazeSession(req);
        res.json({ isAdmin: !!(session && session.unlocked) });
    } catch (err) {
        res.json({ isAdmin: false });
    }
});

// Admin logout
app.post('/api/admin/logout', async (req, res) => {
    try {
        const session = await getMazeSession(req);
        if (session) {
            await MazeSession.findByIdAndDelete(session._id);
        }
        res.clearCookie('maze_session', { path: '/' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to logout' });
    }
});

// Get all canvas messages
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
    try {
        const items = await CanvasItem.find().sort({ timestamp: -1 }).lean();
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Delete a canvas message
app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
    try {
        const item = await CanvasItem.findByIdAndDelete(req.params.id);
        if (!item) return res.status(404).json({ error: 'Not found' });
        broadcast({ type: 'delete_item', id: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// Get all questions (admin)
app.get('/api/admin/questions', requireAdmin, async (req, res) => {
    try {
        const questions = await Question.find().sort({ timestamp: -1 }).lean();
        res.json(questions);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// Create a question — spawns at canvas center (0, 0) for admin to drag into place
app.post('/api/admin/questions', requireAdmin, async (req, res) => {
    try {
        const { question, size, status, expiresAt } = req.body;
        if (!question || question.trim().length === 0) {
            return res.status(400).json({ error: 'Question text required' });
        }
        const sz = Math.min(1000, Math.max(100, parseInt(size) || 500));
        const newQ = await Question.create({
            question: question.trim(),
            size: sz,
            status: status || 'open',
            x: 0,
            y: 0,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            responses: [],
            timestamp: Date.now()
        });
        broadcast({ type: 'new_question', question: newQ.toObject() });
        res.json(newQ.toObject());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create question' });
    }
});

// Update a question (size, status, expiresAt, x, y position)
app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
    try {
        const { size, status, expiresAt, x, y } = req.body;
        const update = {};
        if (size !== undefined) update.size = Math.min(1000, Math.max(100, parseInt(size) || 500));
        if (status !== undefined) update.status = status;
        if (expiresAt !== undefined) update.expiresAt = expiresAt ? new Date(expiresAt) : null;
        if (x !== undefined && y !== undefined) {
            update.x = parseFloat(x);
            update.y = parseFloat(y);
        }

        const q = await Question.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!q) return res.status(404).json({ error: 'Not found' });
        // For position-only updates, broadcast a lighter message
        if (x !== undefined && y !== undefined && Object.keys(update).length === 2) {
            broadcast({ type: 'move_question', id: req.params.id, x: update.x, y: update.y });
        } else {
            broadcast({ type: 'update_question', question: q.toObject() });
        }
        res.json(q.toObject());
    } catch (err) {
        res.status(500).json({ error: 'Failed to update question' });
    }
});

// Delete a question
app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
    try {
        const q = await Question.findByIdAndDelete(req.params.id);
        if (!q) return res.status(404).json({ error: 'Not found' });
        broadcast({ type: 'delete_question', id: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

// Delete a response from a question
app.delete('/api/admin/questions/:qid/responses/:rid', requireAdmin, async (req, res) => {
    try {
        const q = await Question.findById(req.params.qid);
        if (!q) return res.status(404).json({ error: 'Question not found' });
        q.responses = q.responses.filter(r => r._id.toString() !== req.params.rid);
        await q.save();
        broadcast({ type: 'delete_response', questionId: req.params.qid, responseId: req.params.rid });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete response' });
    }
});

// ─── Public Question Routes ───────────────────────────────────────────────────

// Get open questions list (for answer modal)
app.get('/api/questions', async (req, res) => {
    try {
        // Auto-close expired questions
        await Question.updateMany(
            { expiresAt: { $lt: new Date() }, status: 'open' },
            { status: 'closed' }
        );
        const questions = await Question.find({ status: 'open' }).select('-responses').lean();
        res.json(questions);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// Get all questions for canvas rendering
app.get('/api/questions/all', async (req, res) => {
    try {
        const questions = await Question.find().lean();
        res.json(questions);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch questions' });
    }
});

// Submit a response to a question (via HTTP, with cooldown tracked in-memory per session)
const responseCooldowns = new Map(); // questionId+ip -> timestamp

app.post('/api/questions/:id/respond', async (req, res) => {
    try {
        const q = await Question.findById(req.params.id);
        if (!q) return res.status(404).json({ error: 'Question not found' });
        if (q.status !== 'open') return res.status(400).json({ error: 'Question is closed' });

        // Auto-close if expired
        if (q.expiresAt && q.expiresAt < new Date()) {
            q.status = 'closed';
            await q.save();
            return res.status(400).json({ error: 'Question has expired' });
        }

        const { text } = req.body;
        if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Empty response' });
        if (text.trim().length > MAX_RESPONSE_CHARS) {
            return res.status(400).json({ error: `Response too long (max ${MAX_RESPONSE_CHARS} chars)` });
        }

        if (advancedFilter.test(text)) {
            return res.status(400).json({ error: 'Watch your language!' });
        }

        // 60s cooldown per question per IP
        const ip = req.ip;
        const cooldownKey = `${q._id}_${ip}`;
        const lastTime = responseCooldowns.get(cooldownKey);
        if (lastTime && Date.now() - lastTime < 60000) {
            const remaining = Math.ceil((60000 - (Date.now() - lastTime)) / 1000);
            return res.status(429).json({ error: `Please wait ${remaining}s before answering again` });
        }

        // Find placement with massive, randomized font size dynamically capped so it doesn't break the 35px spill limit
        const minFontSize = 24;
        const maxPermittedByWidth = Math.floor((q.size + 20) / (text.trim().length * 0.6));
        const maxFontSize = Math.max(minFontSize, Math.min(68, maxPermittedByWidth));
        const randomFontSize = Math.floor(Math.random() * (maxFontSize - minFontSize + 1)) + minFontSize;
        const pos = findResponsePosition(q, text.trim(), randomFontSize);
        if (!pos) {
            return res.status(400).json({ error: 'This circle is full! No more responses fit.' });
        }

        const newResponse = {
            _id: uuidv4(),
            text: text.trim(),
            x: pos.x,
            y: pos.y,
            fontSize: randomFontSize,
            rotation: 0,
            timestamp: Date.now()
        };

        q.responses.push(newResponse);
        await q.save();

        responseCooldowns.set(cooldownKey, Date.now());

        broadcast({ type: 'new_response', questionId: q._id.toString(), response: newResponse });
        res.json({ success: true, response: newResponse });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Check if a question can fit one more response
app.get('/api/questions/:id/capacity', async (req, res) => {
    try {
        const q = await Question.findById(req.params.id).lean();
        if (!q) return res.status(404).json({ error: 'Not found' });
        const canFit = canFitMoreResponse(q);
        res.json({ canFit, status: q.status });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Original API ─────────────────────────────────────────────────────────────

app.get('/api/data', async (req, res) => {
    try {
        const canvasItems = await CanvasItem.find().lean();
        const jokeData = JSON.parse(fs.readFileSync(JOKE_FILE, 'utf8'));
        res.json({ canvas: canvasItems, jokes: jokeData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read data' });
    }
});



// ─── WebSocket ────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
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
    broadcast({ type: 'online_count', count: wss.clients.size });
}

function broadcastViewports() {
    const viewports = [];
    clients.forEach((data, ws) => {
        if (data.viewport) viewports.push({ id: data.id, ...data.viewport });
    });
    broadcast({ type: 'viewports', viewports });
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const id = Math.random().toString(36).substr(2, 9);
    clients.set(ws, { ip, id, viewport: null });
    ws.send(JSON.stringify({ type: 'init', id }));
    broadcastOnlineCount();

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'viewport') {
                const clientData = clients.get(ws);
                if (clientData) {
                    clientData.viewport = data.viewport;
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
                    const canvasData = await CanvasItem.find({}, 'x y text fontSize rotation').lean();
                    const questions = await Question.find({}, 'x y size').lean();
                    let newItem = null;
                    let attempts = 0;
                    const maxAttempts = 5000;

                    while (!newItem && attempts < maxAttempts) {
                        const count = canvasData.length;
                        const gap = 500;
                        let expansion = 0;
                        if (attempts > 100) expansion = (attempts - 100) * 5;
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

                        const candidate = { text, x, y, rotation, fontSize, color, timestamp: Date.now() };
                        if (!checkCollision(candidate, canvasData, questions)) {
                            newItem = candidate;
                        }
                        attempts++;
                    }

                    if (!newItem) {
                        ws.send(JSON.stringify({ type: 'submit_error', error: 'Canvas too crowded near center, try again.' }));
                        return;
                    }

                    const saved = await CanvasItem.create(newItem);
                    const itemObj = { ...newItem, id: saved._id.toString(), _id: saved._id.toString() };
                    ws.send(JSON.stringify({ type: 'submit_success', item: itemObj }));
                    broadcast({ type: 'new_item', item: itemObj }, ws);

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
        broadcastViewports();
    });
});

// ─── Data migration: load canvas_data.json into MongoDB if DB is empty ────────

async function migrateJsonToMongo() {
    try {
        const count = await CanvasItem.countDocuments();
        if (count === 0 && fs.existsSync(DATA_FILE)) {
            const items = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (items.length > 0) {
                await CanvasItem.insertMany(items);
                console.log(`Migrated ${items.length} canvas items from JSON to MongoDB`);
            }
        }
    } catch (err) {
        console.error('Migration error:', err);
    }
}

server.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await migrateJsonToMongo();
});
