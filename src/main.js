import './style.css';
import { makeDefaultConfig, makeRow, History } from './state';
import { Renderer } from './renderer';
import { PRESETS, buildRowsFromSections } from './presets';
import { saveToJson, loadFromJson, encodeToHash, decodeFromHash, exportToPng } from './serializer';
// --- App state ---
let config = makeDefaultConfig();
const history = new History();
const renderer = new Renderer();
let activeColor = '#a8d8ea';
let activeTool = 'color';
// --- DOM refs ---
const canvas = document.getElementById('chart-canvas');
const titleInput = document.getElementById('title');
const layoutSelect = document.getElementById('layout');
const notesArea = document.getElementById('notes');
const showNumbersCheck = document.getElementById('show-numbers');
const restartNumbersCheck = document.getElementById('restart-numbers');
const showRowLabelsCheck = document.getElementById('show-row-labels');
const conductorStandCheck = document.getElementById('conductor-stand');
const flipCheck = document.getElementById('flip');
const straightRowsInput = document.getElementById('straight-rows');
const straightRowsLabel = document.getElementById('straight-rows-label');
const rowsContainer = document.getElementById('rows-container');
const colorPicker = document.getElementById('color-picker');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const addRowBtn = document.getElementById('add-row-btn');
const saveBtn = document.getElementById('save-btn');
const loadInput = document.getElementById('load-input');
const exportPngBtn = document.getElementById('export-png-btn');
const shareLinkBtn = document.getElementById('share-link-btn');
const shareUrlDisplay = document.getElementById('share-url-display');
const presetSelect = document.getElementById('preset-select');
const applyPresetBtn = document.getElementById('apply-preset-btn');
const toolButtons = document.querySelectorAll('[data-tool]');
// --- Init ---
function init() {
    if (location.hash) {
        const loaded = decodeFromHash(location.hash);
        if (loaded)
            config = loaded;
    }
    populatePresets();
    updateAllInputs();
    renderChart();
    bindEvents();
}
// --- Render ---
function renderChart() {
    resizeCanvas();
    renderer.render(canvas, config);
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();
}
function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = Math.max(500, container.clientHeight);
}
// --- Sync inputs → config ---
function readInputs() {
    history.push(config);
    config.title = titleInput.value;
    config.layout = layoutSelect.value;
    config.notes = notesArea.value;
    config.showNumbers = showNumbersCheck.checked;
    config.numberRestartPerRow = restartNumbersCheck.checked;
    config.showRowLabels = showRowLabelsCheck.checked;
    config.conductor.hasStand = conductorStandCheck.checked;
    config.flipped = flipCheck.checked;
    config.straightRows = Math.max(0, Math.min(config.rows.length, Number(straightRowsInput.value) || 0));
}
// --- Sync config → inputs ---
function updateAllInputs() {
    titleInput.value = config.title;
    layoutSelect.value = config.layout;
    notesArea.value = config.notes;
    showNumbersCheck.checked = config.showNumbers;
    restartNumbersCheck.checked = config.numberRestartPerRow;
    showRowLabelsCheck.checked = config.showRowLabels;
    conductorStandCheck.checked = config.conductor.hasStand;
    flipCheck.checked = config.flipped;
    straightRowsInput.value = String(config.straightRows);
    straightRowsInput.max = String(config.rows.length);
    // Only show straight-rows control in semicircle mode
    straightRowsLabel.style.display = config.layout === 'semicircle' ? '' : 'none';
    renderRowList();
}
// --- Row list UI ---
function renderRowList() {
    rowsContainer.innerHTML = '';
    config.rows.forEach((row, i) => {
        const div = document.createElement('div');
        div.className = 'row-item';
        div.innerHTML = `
      <span class="row-id">Row ${row.label}</span>
      <label>Chairs
        <input type="number" min="1" max="30" value="${row.chairs.length}" data-row="${i}" class="chair-count">
      </label>
      <label>Label
        <input type="text" maxlength="4" value="${row.label}" data-row="${i}" class="row-label-input">
      </label>
      <button data-row="${i}" class="remove-row-btn" ${config.rows.length <= 1 ? 'disabled' : ''}>✕</button>
    `;
        rowsContainer.appendChild(div);
    });
}
// --- Presets ---
function populatePresets() {
    PRESETS.forEach(preset => {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name;
        presetSelect.appendChild(opt);
    });
}
function applyPreset(presetId) {
    const preset = PRESETS.find(p => p.id === presetId);
    if (!preset)
        return;
    history.push(config);
    const sections = preset.sections.map(s => ({ ...s }));
    const rows = buildRowsFromSections(sections);
    config.rows = rows;
    config.layout = preset.layout;
    config.title = preset.name;
    layoutSelect.value = preset.layout;
    titleInput.value = preset.name;
    updateAllInputs();
    renderChart();
}
// --- Canvas interaction ---
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = renderer.hitTest(x, y);
    if (!hit)
        return;
    history.push(config);
    const chair = config.rows[hit.rowIndex].chairs[hit.chairIndex];
    if (activeTool === 'color') {
        chair.color = activeColor;
    }
    else if (activeTool === 'toggle') {
        chair.enabled = !chair.enabled;
    }
    else if (activeTool === 'stand') {
        chair.hasStand = !chair.hasStand;
    }
    renderChart();
});
// --- Events ---
function bindEvents() {
    for (const el of [titleInput, layoutSelect, notesArea, showNumbersCheck,
        restartNumbersCheck, showRowLabelsCheck, conductorStandCheck, flipCheck,
        straightRowsInput]) {
        el.addEventListener('change', () => { readInputs(); updateAllInputs(); renderChart(); });
    }
    // Row list: chair count + label changes
    rowsContainer.addEventListener('change', (e) => {
        const target = e.target;
        const rowIdx = Number(target.dataset['row']);
        if (isNaN(rowIdx))
            return;
        history.push(config);
        if (target.classList.contains('chair-count')) {
            const count = Math.max(1, Math.min(30, Number(target.value)));
            const current = config.rows[rowIdx].chairs;
            if (count > current.length) {
                for (let i = current.length; i < count; i++) {
                    current.push({ id: crypto.randomUUID(), enabled: true, color: '#e8e8e8', label: '', hasStand: false });
                }
            }
            else {
                config.rows[rowIdx].chairs = current.slice(0, count);
            }
        }
        else if (target.classList.contains('row-label-input')) {
            config.rows[rowIdx].label = target.value;
            renderRowList();
        }
        renderChart();
    });
    // Row list: remove row
    rowsContainer.addEventListener('click', (e) => {
        const target = e.target;
        if (!target.classList.contains('remove-row-btn'))
            return;
        const rowIdx = Number(target.dataset['row']);
        if (isNaN(rowIdx) || config.rows.length <= 1)
            return;
        history.push(config);
        config.rows.splice(rowIdx, 1);
        // Clamp straightRows to new row count
        config.straightRows = Math.min(config.straightRows, config.rows.length);
        updateAllInputs();
        renderChart();
    });
    addRowBtn.addEventListener('click', () => {
        history.push(config);
        const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const label = labels[config.rows.length] ?? String(config.rows.length + 1);
        config.rows.push(makeRow(8, label));
        updateAllInputs();
        renderChart();
    });
    // Tool selection
    toolButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            activeTool = btn.dataset['tool'];
            toolButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    colorPicker.addEventListener('input', () => {
        activeColor = colorPicker.value;
    });
    // Undo / redo
    undoBtn.addEventListener('click', () => {
        const prev = history.undo(config);
        if (prev) {
            config = prev;
            updateAllInputs();
            renderChart();
        }
    });
    redoBtn.addEventListener('click', () => {
        const next = history.redo(config);
        if (next) {
            config = next;
            updateAllInputs();
            renderChart();
        }
    });
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            const prev = history.undo(config);
            if (prev) {
                config = prev;
                updateAllInputs();
                renderChart();
            }
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            const next = history.redo(config);
            if (next) {
                config = next;
                updateAllInputs();
                renderChart();
            }
        }
    });
    // Save / load
    saveBtn.addEventListener('click', () => saveToJson(config));
    loadInput.addEventListener('change', async () => {
        const file = loadInput.files?.[0];
        if (!file)
            return;
        try {
            config = await loadFromJson(file);
            updateAllInputs();
            renderChart();
        }
        catch {
            alert('Could not load chart file.');
        }
        loadInput.value = '';
    });
    exportPngBtn.addEventListener('click', () => exportToPng(canvas, config.title));
    shareLinkBtn.addEventListener('click', () => {
        const hash = encodeToHash(config);
        const url = location.origin + location.pathname + hash;
        navigator.clipboard.writeText(url).catch(() => { });
        shareUrlDisplay.textContent = url;
        shareUrlDisplay.style.display = 'block';
    });
    applyPresetBtn.addEventListener('click', () => {
        applyPreset(presetSelect.value);
    });
    window.addEventListener('resize', renderChart);
}
init();
