// All DOM element references in one place. Looked up once at module load
// (matches the previous behaviour of the inline `document.getElementById`
// calls at the top of main.ts) and exported as named consts so call sites
// don't need to know about IDs.
//
// If a control gets added to index.html, register it here too.

export const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement

// --- Chart panel ---
export const titleInput = document.getElementById('title') as HTMLInputElement
export const layoutSelect = document.getElementById('layout') as HTMLSelectElement
export const notesArea = document.getElementById('notes') as HTMLTextAreaElement
export const showNumbersCheck = document.getElementById('show-numbers') as HTMLInputElement
export const restartNumbersCheck = document.getElementById('restart-numbers') as HTMLInputElement
export const showRowLabelsCheck = document.getElementById('show-row-labels') as HTMLInputElement
export const conductorStandCheck = document.getElementById('conductor-stand') as HTMLInputElement
export const flipCheck = document.getElementById('flip') as HTMLInputElement
export const straightRowsInput = document.getElementById('straight-rows') as HTMLInputElement
export const straightRowsLabel = document.getElementById('straight-rows-label') as HTMLElement

// --- Advanced layout modal ---
export const advancedBtn = document.getElementById('advanced-btn') as HTMLButtonElement
export const advancedModal = document.getElementById('advanced-modal') as HTMLElement
export const advancedCloseBtn = document.getElementById('advanced-close') as HTMLButtonElement
export const showArcCheck = document.getElementById('show-arc') as HTMLInputElement
export const showStageDirectionsCheck = document.getElementById('show-stage-directions') as HTMLInputElement
export const chartScaleInput = document.getElementById('chart-scale') as HTMLInputElement
export const arcRangeInput = document.getElementById('arc-range') as HTMLInputElement
export const arcRangeLabel = document.getElementById('arc-range-label') as HTMLElement
export const rowSpacingInput = document.getElementById('row-spacing') as HTMLInputElement
export const showCreditCheck = document.getElementById('show-credit') as HTMLInputElement
export const resetPositionBtn = document.getElementById('reset-position-btn') as HTMLButtonElement

// --- Preset panel + custom orchestra modal ---
export const presetSelect = document.getElementById('preset-select') as HTMLSelectElement
export const applyPresetBtn = document.getElementById('apply-preset-btn') as HTMLButtonElement
export const customOrchestraBtn = document.getElementById('custom-orchestra-btn') as HTMLButtonElement
export const customOrchestraModal = document.getElementById('custom-orchestra-modal') as HTMLElement
export const customOrchestraTitle = document.getElementById('custom-orchestra-title') as HTMLInputElement
export const customOrchestraNotation = document.getElementById('custom-orchestra-notation') as HTMLInputElement
export const customOrchestraPreview = document.getElementById('custom-orchestra-preview') as HTMLElement
export const customOrchestraApply = document.getElementById('custom-orchestra-apply') as HTMLButtonElement
export const customOrchestraCancel = document.getElementById('custom-orchestra-cancel') as HTMLButtonElement

// --- Row list + edit-chairs panel ---
export const rowsContainer = document.getElementById('rows-container') as HTMLElement
export const addRowBtn = document.getElementById('add-row-btn') as HTMLButtonElement
export const colorPicker = document.getElementById('color-picker') as HTMLInputElement
export const colorPickerLabel = document.getElementById('color-picker-label') as HTMLElement
export const toolButtons = document.querySelectorAll<HTMLButtonElement>('[data-tool]')
export const instrumentPickerPanel = document.getElementById('instrument-picker-panel') as HTMLElement
export const instrumentPickerList = document.getElementById('instrument-picker-list') as HTMLElement
export const instrumentPickerStatus = document.getElementById('instrument-picker-status') as HTMLElement

// --- Fixed instruments panel ---
export const addInstrumentButtons = document.querySelectorAll<HTMLButtonElement>('[data-add-instrument]')
export const inspector = document.getElementById('instrument-inspector') as HTMLElement
export const inspectorType = document.getElementById('inspector-type') as HTMLElement
export const inspectorLabel = document.getElementById('inspector-label') as HTMLInputElement
export const inspectorCountLabel = document.getElementById('inspector-count-label') as HTMLElement
export const inspectorCount = document.getElementById('inspector-count') as HTMLInputElement
export const inspectorRotateLeft = document.getElementById('inspector-rotate-left') as HTMLButtonElement
export const inspectorRotateRight = document.getElementById('inspector-rotate-right') as HTMLButtonElement
export const inspectorDelete = document.getElementById('inspector-delete') as HTMLButtonElement

// --- Stage background panel ---
export const bgInput = document.getElementById('bg-input') as HTMLInputElement
export const bgClearBtn = document.getElementById('bg-clear-btn') as HTMLButtonElement
export const bgStatus = document.getElementById('bg-status') as HTMLElement
export const bgFitSelect = document.getElementById('bg-fit') as HTMLSelectElement

// --- History panel ---
export const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement
export const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement

// --- Save & export panel ---
export const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
export const loadInput = document.getElementById('load-input') as HTMLInputElement
export const exportPngBtn = document.getElementById('export-png-btn') as HTMLButtonElement
export const shareLinkBtn = document.getElementById('share-link-btn') as HTMLButtonElement
export const shareUrlDisplay = document.getElementById('share-url-display') as HTMLElement
