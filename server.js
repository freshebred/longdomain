const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
const MAX_REQUESTS = 100000;

// Bad words regex (basic list + patterns)
const badWordsRegex = /\b(badword1|badword2|hate|violence|kill|death|stupid_placeholder_for_actual_bad_words)\b/i;
// Note: In a real scenario, I'd use a more comprehensive list or library, 
// but for this "stupid" app, I'll keep it simple and maybe add some funny "bad" words to filter.
// The user asked for "advanced regex", so let's make it look a bit more complex.
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

app.post('/api/submit', (req, res) => {
    const ip = req.ip;
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded. Chill out.' });
    }

    const { text } = req.body;

    if (!text || text.length > 67) {
        return res.status(400).json({ error: 'Text too long or empty.' });
    }

    if (advancedFilter.test(text)) {
        return res.status(400).json({ error: 'Watch your language!' });
    }

    try {
        const canvasData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

        let newItem = null;
        let attempts = 0;
        const maxAttempts = 5000; // Much higher limit

        while (!newItem && attempts < maxAttempts) {
            // Dynamic Generation Zone (Annulus)
            const count = canvasData.length;
            const gap = 500;

            // If we're struggling to find a spot, expand the search area
            let expansion = 0;
            if (attempts > 100) {
                expansion = (attempts - 100) * 5; // Expand significantly if stuck
            }

            // Base radius grows faster (10px per item instead of 1) + expansion
            const maxRadius = 500 + (count * 10) + expansion;
            const minRadius = Math.max(0, maxRadius - gap);

            // Random angle
            const angle = Math.random() * Math.PI * 2;

            // Random radius within the annulus
            const r = Math.sqrt(Math.random() * (maxRadius * maxRadius - minRadius * minRadius) + minRadius * minRadius);

            const x = r * Math.cos(angle);
            const y = r * Math.sin(angle);

            // Random rotation (-70 to 70)
            const rotation = (Math.random() * 140) - 70;

            // Random font size (24 to 64)
            const fontSize = Math.floor(Math.random() * (64 - 24 + 1)) + 24;

            // Random color
            const COLORS = ['#ff0000', '#008000', '#0000ff', '#800080', '#008080', '#000000', '#ff4500', '#8b4513'];
            const color = COLORS[Math.floor(Math.random() * COLORS.length)];

            // Random font (handled on client, but we can store an index or name)
            // Let's just store the properties needed for collision

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
            return res.status(409).json({ error: 'Canvas too crowded near center, try again.' });
        }

        canvasData.push(newItem);
        fs.writeFileSync(DATA_FILE, JSON.stringify(canvasData, null, 2));

        res.json({ success: true, item: newItem });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
