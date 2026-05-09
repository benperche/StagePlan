const CURRENT_VERSION = 1;
export function saveToJson(config) {
    const json = JSON.stringify({ ...config, version: CURRENT_VERSION }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.title.replace(/\s+/g, '_') || 'seating_chart'}.json`;
    a.click();
    URL.revokeObjectURL(url);
}
export function loadFromJson(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                resolve(migrate(data));
            }
            catch {
                reject(new Error('Invalid chart file'));
            }
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsText(file);
    });
}
// Migrate older saved formats forward
function migrate(data) {
    const version = data['version'] ?? 0;
    if (version === CURRENT_VERSION)
        return data;
    // Future migrations go here as version numbers increase
    return data;
}
// URL hash encoding — LZ-style compression via built-in btoa
export function encodeToHash(config) {
    const json = JSON.stringify(config);
    // btoa requires ASCII; encode UTF-8 safely
    const encoded = btoa(encodeURIComponent(json));
    return '#' + encoded;
}
export function decodeFromHash(hash) {
    try {
        const encoded = hash.replace(/^#/, '');
        const json = decodeURIComponent(atob(encoded));
        return migrate(JSON.parse(json));
    }
    catch {
        return null;
    }
}
export function exportToPng(canvas, title) {
    canvas.toBlob((blob) => {
        if (!blob)
            return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.replace(/\s+/g, '_') || 'seating_chart'}.png`;
        a.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
}
