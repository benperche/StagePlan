const CHAIR_COLORS = [
    '#e8e8e8', // default
];
export function makeChair() {
    return {
        id: crypto.randomUUID(),
        enabled: true,
        color: CHAIR_COLORS[0],
        label: '',
        hasStand: false,
    };
}
export function makeRow(chairCount, label) {
    return {
        id: crypto.randomUUID(),
        chairs: Array.from({ length: chairCount }, () => makeChair()),
        label,
        fontSize: 13,
    };
}
export function makeDefaultConfig() {
    return {
        version: 1,
        title: 'Seating Chart',
        layout: 'semicircle',
        rows: [
            makeRow(8, 'A'),
            makeRow(10, 'B'),
            makeRow(12, 'C'),
        ],
        straightRows: 0,
        conductor: { hasStand: true },
        flipped: false,
        showNumbers: true,
        numberRestartPerRow: false,
        showRowLabels: false,
        notes: '',
    };
}
// Deep clone via JSON — safe for plain data objects
export function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config));
}
// --- Undo/redo stack ---
const MAX_HISTORY = 50;
export class History {
    constructor() {
        Object.defineProperty(this, "past", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "future", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
    }
    push(config) {
        this.past.push(cloneConfig(config));
        if (this.past.length > MAX_HISTORY)
            this.past.shift();
        this.future = [];
    }
    undo(current) {
        if (this.past.length === 0)
            return null;
        this.future.push(cloneConfig(current));
        return this.past.pop();
    }
    redo(current) {
        if (this.future.length === 0)
            return null;
        this.past.push(cloneConfig(current));
        return this.future.pop();
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
}
