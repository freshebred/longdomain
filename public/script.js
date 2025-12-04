const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const itemsContainer = document.getElementById('items-container');
const overlayLines = document.getElementById('overlay-lines');
const userInput = document.getElementById('user-input');
const submitBtn = document.getElementById('submit-btn');
const statusMsg = document.getElementById('status-msg');
const popupsLayer = document.getElementById('popups-layer');

// State
let scale = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let startX, startY;
let lastPanX, lastPanY;
let canvasItems = [];
let jokeLines = [];
let targetItem = null; // The item to point to with the yellow line

// Constants
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const COLORS = ['#ff0000', '#008000', '#0000ff', '#800080', '#008080', '#000000', '#ff4500', '#8b4513'];

// Initialization
async function init() {
    await fetchData();
    setupEventListeners();
    renderItems();
    startStupidLoop();
    requestAnimationFrame(gameLoop);
}

async function fetchData() {
    try {
        const res = await fetch('/api/data');
        const data = await res.json();
        canvasItems = data.canvas;
        jokeLines = data.jokes;
        renderItems();
    } catch (err) {
        console.error('Failed to fetch data', err);
    }
}

function setupEventListeners() {
    // Panning
    viewport.addEventListener('mousedown', e => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        lastPanX = panX;
        lastPanY = panY;
        viewport.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
        if (isDragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panX = lastPanX + dx;
            panY = lastPanY + dy;
            updateTransform();
        }
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
        viewport.style.cursor = 'grab';
    });

    // Zooming
    viewport.addEventListener('wheel', e => {
        e.preventDefault();
        const zoomIntensity = 0.1;
        const delta = -Math.sign(e.deltaY);
        const newScale = scale + (delta * zoomIntensity * scale);

        if (newScale >= MIN_SCALE && newScale <= MAX_SCALE) {
            scale = newScale;
            updateTransform();
        }
    }, { passive: false });

    // Submission
    submitBtn.addEventListener('click', submitText);
    userInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') submitText();
    });

    // Mobile Touch
    viewport.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            lastPanX = panX;
            lastPanY = panY;
        }
    });

    viewport.addEventListener('touchmove', e => {
        if (isDragging && e.touches.length === 1) {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            panX = lastPanX + dx;
            panY = lastPanY + dy;
            updateTransform();
        }
    });

    viewport.addEventListener('touchend', () => {
        isDragging = false;
    });
}

function updateTransform() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    updateOverlay();
}

function renderItems() {
    if (!itemsContainer) return;
    itemsContainer.innerHTML = ''; // Clear and rebuild

    canvasItems.forEach(item => {
        const el = document.createElement('div');
        el.className = 'canvas-item';
        el.textContent = item.text;
        el.style.left = `${item.x}px`;
        el.style.top = `${item.y}px`;
        el.style.transform = `translate(-50%, -50%) rotate(${item.rotation}deg)`;
        el.style.fontSize = `${item.fontSize}px`;
        const fontIndex = Math.abs(hashCode(item.text)) % 12;
        el.classList.add(`font-${fontIndex}`);

        // Use stored color, or deterministic hash for old items
        const colorIndex = Math.abs(hashCode(item.text + (item.timestamp || ''))) % COLORS.length;
        el.style.color = item.color || COLORS[colorIndex];

        itemsContainer.appendChild(el);
    });
}

async function submitText() {
    const text = userInput.value.trim();
    if (!text) return;

    statusMsg.textContent = 'SENDING...';

    try {
        const res = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });

        const data = await res.json();

        if (res.ok) {
            statusMsg.textContent = 'SENT!';
            userInput.value = '';
            canvasItems.push(data.item);
            renderItems();
            targetItem = data.item;
        } else {
            statusMsg.textContent = data.error || 'ERROR';
        }
    } catch (err) {
        statusMsg.textContent = 'NETWORK ERROR';
    }

    setTimeout(() => { statusMsg.textContent = ''; }, 3000);
}

function updateOverlay() {
    overlayLines.innerHTML = '';

    if (targetItem) {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        const itemScreenX = centerX + panX + (targetItem.x * scale);
        const itemScreenY = centerY + panY + (targetItem.y * scale);

        if (itemScreenX < 0 || itemScreenX > window.innerWidth ||
            itemScreenY < 0 || itemScreenY > window.innerHeight) {

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', centerX);
            line.setAttribute('y1', centerY);
            line.setAttribute('x2', itemScreenX);
            line.setAttribute('y2', itemScreenY);
            line.setAttribute('stroke', 'yellow');
            line.setAttribute('stroke-width', '2');
            overlayLines.appendChild(line);
        } else {
            targetItem = null;
        }
    }
}

function gameLoop() {
    updateOverlay();
    requestAnimationFrame(gameLoop);
}

function startStupidLoop() {
    setInterval(() => {
        if (Math.random() > 0.7) spawnPopup();
    }, 10000);

    setInterval(() => {
        if (Math.random() > 0.5) spawnGroundShape();
    }, 5000);
}

function spawnPopup() {
    if (!jokeLines.length) return;
    const text = jokeLines[Math.floor(Math.random() * jokeLines.length)];

    const popup = document.createElement('div');
    popup.className = 'stupid-popup';
    popup.style.left = `${Math.random() * (window.innerWidth - 200)}px`;
    popup.style.top = `${Math.random() * (window.innerHeight - 150)}px`;

    popup.innerHTML = `
        <div class="popup-header">
            <span>MESSAGE</span>
            <span class="popup-close" onclick="this.parentElement.parentElement.remove()">X</span>
        </div>
        <div class="popup-content">
            ${text}
        </div>
    `;

    popupsLayer.appendChild(popup);
    setTimeout(() => popup.remove(), 8000);
}

function spawnGroundShape() {
    if (!itemsContainer) return;
    const shape = document.createElement('div');
    shape.className = 'stupid-shape';

    const size = Math.random() * 200 + 50;
    shape.style.width = `${size}px`;
    shape.style.height = `${size}px`;
    shape.style.border = `${Math.random() * 10 + 2}px solid ${COLORS[Math.floor(Math.random() * COLORS.length)]}`;
    shape.style.left = `${(Math.random() - 0.5) * 2000}px`;
    shape.style.top = `${(Math.random() - 0.5) * 2000}px`;
    shape.style.transform = `rotate(${Math.random() * 360}deg)`;

    const type = Math.random();
    if (type < 0.33) {
        shape.style.borderRadius = '50%';
    } else if (type < 0.66) {
        shape.style.width = '0';
        shape.style.height = '0';
        shape.style.borderLeft = `${size / 2}px solid transparent`;
        shape.style.borderRight = `${size / 2}px solid transparent`;
        shape.style.borderBottom = `${size}px solid ${COLORS[Math.floor(Math.random() * COLORS.length)]}`;
        shape.style.backgroundColor = 'transparent';
        shape.style.borderTop = 'none';
    }

    if (jokeLines.length && Math.random() > 0.5) {
        const text = document.createElement('div');
        text.textContent = jokeLines[Math.floor(Math.random() * jokeLines.length)];
        text.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];
        text.style.fontSize = '12px';
        text.style.textAlign = 'center';
        text.style.width = '100%';
        text.style.position = 'absolute';
        text.style.top = '50%';
        text.style.transform = 'translateY(-50%)';
        shape.appendChild(text);
    }

    itemsContainer.insertBefore(shape, itemsContainer.firstChild);

    const shapes = document.querySelectorAll('.stupid-shape');
    if (shapes.length > 20) shapes[0].remove();
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
}

init();
