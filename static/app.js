// Video Trimmer JavaScript
let cuts = [];
let selectionMode = 'cut';
let slider = null;
let timestampsDiv = null;
let video = null;
let isProcessing = false;
let videoDuration = 0;
let videoFilename = "";
let finalDurationEl = null;
let origBytes = 0;
let sourceBitrateKbps = 0;
let srcVCodec = 'h264';
let srcACodec = 'aac';
let srcContainer = 'mp4';
let startTimeMs = null; // track processing start for ETA
let etaHistory = [];
// Merge job state for multi-clip processing
let mergeState = { jobId: null, polling: null };
// Suppress seeking video during programmatic slider updates
let suppressSliderSeek = false;
// Undo/Redo history and double right-click detection for cut edits
let undoStack = [];
let redoStack = [];
let lastContextDelete = { idx: -1, t: 0 };
// Preview player state for kept segments only
let previewState = {
    playing: false,
    totalKept: 0,      // total duration after cuts
    segments: [],      // array of kept {start,end,dur,accumStart}
    sliderEl: null,
    playBtn: null,
    timeEl: null,
    currentKeptPos: 0,  // seconds within kept timeline
    suppressSlider: false
};

// Click near the start boundary (head) of a cut range to snap video to that frame
function handleTimelineClickSeek(e){
    try {
        if (!slider || !video || !Number.isFinite(videoDuration) || videoDuration <= 0) return;
        if (addPlacementArmed) return; // let placement mode handle clicks
        // Left-click only
        if (e.button !== 0) return;
        // If clicking directly on a handle (.noUi-touch-area/.noUi-handle), snap exactly to that handle's time
        if (e.target && typeof e.target.closest === 'function'){
            const handleEl = e.target.closest('.noUi-handle');
            if (handleEl && slider.noUiSlider) {
                const handles = Array.from(slider.querySelectorAll('.noUi-handle'));
                const idx = handles.indexOf(handleEl);
                if (idx >= 0) {
                    let vals = slider.noUiSlider.get();
                    if (!Array.isArray(vals)) vals = [vals];
                    const t = parseFloat(vals[idx]);
                    if (Number.isFinite(t)) {
                        video.currentTime = t;
                        // Allow default so dragging still works; we only snap playback
                        return;
                    }
                }
            }
        }
        const rect = slider.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const x = e.clientX - rect.left;
        const tolPx = 8; // pixel tolerance for clicking the head
        // Normalize cuts
        const norm = (cuts||[]).map(c=>({start:Math.max(0,Math.min(videoDuration, +c.start||0)), end:Math.max(0,Math.min(videoDuration, +c.end||0))}))
            .filter(c=>c.end>c.start+0.01).sort((a,b)=>a.start-b.start);
        if (!norm.length) return;
        // Find closest boundary (start or end) in pixels
        let best = {dist: Infinity, t: null};
        for (const c of norm){
            const pxStart = (c.start / videoDuration) * rect.width;
            const dStart = Math.abs(x - pxStart);
            if (dStart < best.dist) best = {dist: dStart, t: c.start};
            const pxEnd = (c.end / videoDuration) * rect.width;
            const dEnd = Math.abs(x - pxEnd);
            if (dEnd < best.dist) best = {dist: dEnd, t: c.end};
        }
        if (best.t !== null && best.dist <= tolPx){
            // Prevent slider default click behavior to avoid unintended drags/moves
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            video.currentTime = best.t;
        }
    } catch {}
}

// Placement mode for adding a cut at a clicked position on the slider
let addPlacementArmed = false;
function armAddCutPlacement(){
    if (!slider) return;
    const btn = document.getElementById('btn-add-cut');
    // Toggle on/off
    if (addPlacementArmed) { return disarmPlacement(); }
    addPlacementArmed = true;
    if (btn) { btn.textContent = 'Click on timeline… (Esc to cancel)'; btn.style.background = '#0d6efd'; btn.style.color = '#fff'; }
    slider.style.outline = '2px dashed #0d6efd';
    slider.style.outlineOffset = '2px';
    const handler = (e) => {
        const type = e.type;
        // Cancel with right-click
        if (type === 'contextmenu') {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            disarmPlacement();
            return;
        }
        // Prefer pointerdown/mousedown for immediate placement
        if ((type === 'pointerdown' || type === 'mousedown')) {
            const btn = e.button;
            if (btn !== 0) { // not left button
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();
                disarmPlacement();
                return;
            }
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            const rect = slider.getBoundingClientRect();
            if (!rect || rect.width <= 0 || !Number.isFinite(videoDuration) || videoDuration <= 0) { disarmPlacement(); return; }
            const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            const t = (x / rect.width) * videoDuration;
            addCutAt(t);
            // Keep armed for multiple placements; do not cleanup
            return;
        }
        // Swallow the subsequent click to avoid duplicate
        if (type === 'click') {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            return;
        }
    };
    const disarmPlacement = () => {
        addPlacementArmed = false;
        slider.style.outline = '';
        slider.removeEventListener('click', handler, true);
        slider.removeEventListener('pointerdown', handler, true);
        slider.removeEventListener('mousedown', handler, true);
        slider.removeEventListener('contextmenu', handler, true);
        document.removeEventListener('keydown', escHandler, true);
        if (btn) { btn.textContent = '➕ Add Cut Range'; btn.style.background = ''; btn.style.color = ''; }
    };
    const escHandler = (ev) => { if (ev.key === 'Escape') { disarmPlacement(); } };
    slider.addEventListener('click', handler, true);
    slider.addEventListener('pointerdown', handler, true);
    slider.addEventListener('mousedown', handler, true);
    slider.addEventListener('contextmenu', handler, true);
    document.addEventListener('keydown', escHandler, true);
}

function addCutAt(centerTime){
    if (!Number.isFinite(centerTime)) return;
    // Default cut half-length scales with zoom (shorter when zoomed in)
    const fullLen = computeDefaultCutLength();
    // Allow larger defaults for long videos; cap extreme values for safety
    const half = Math.max(0.1, Math.min(300, fullLen / 2));
    let start = Math.max(0, centerTime - half);
    let end = Math.min(videoDuration, centerTime + half);
    if (end - start < 0.2) { // ensure minimum length
        end = Math.min(videoDuration, start + 0.2);
        if (end - start < 0.2) {
            start = Math.max(0, end - 0.2);
        }
    }
    // Merge with existing cuts if overlapping, otherwise insert in order
    const newCut = { start, end };
    // Normalize existing cuts
    const norm = (cuts||[]).map(c=>({start:Math.max(0,Math.min(videoDuration, +c.start||0)), end:Math.max(0,Math.min(videoDuration, +c.end||0))}))
        .filter(c=>c.end>c.start+0.05).sort((a,b)=>a.start-b.start);
    // Try to avoid overlapping too much: snap inside free gap if available
    for (let i=0;i<norm.length;i++){
        const c = norm[i];
        if (newCut.start < c.end && newCut.end > c.start){
            // Overlaps; expand to union
            newCut.start = Math.min(newCut.start, c.start);
            newCut.end = Math.max(newCut.end, c.end);
            norm.splice(i,1); i--; // remove merged cut and continue merging
        }
    }
    norm.push(newCut);
    norm.sort((a,b)=>a.start-b.start);
    cuts = norm;
    // Ensure slider exists and update
    if (slider && slider.noUiSlider) {
        // history snapshot
        if (typeof saveForUndo === 'function') saveForUndo();
        updateSlider();
    } else {
        // Create a first cut via existing addCut logic path
        // Emulate the initial creation by directly creating slider here
        if (slider) {
            try { suppressSliderSeek = true; } catch {}
            noUiSlider.create(slider, {
                start: [newCut.start, newCut.end],
                connect: [false, true, false],
                range: { min: 0, max: videoDuration },
                step: computeStepFromZoom(),
                behaviour: 'tap-drag',
                tooltips: true,
            });
            slider.noUiSlider.on('update', function(values, handle){
                const val = parseFloat(values[handle]);
                if (Number.isFinite(val) && video && !suppressSliderSeek) {
                    video.currentTime = val;
                }
                updateTimestamps();
            });
            // Enable undo/redo snapshots for initial creation and handle drags
            if (typeof saveForUndo === 'function') saveForUndo();
            if (slider.noUiSlider && typeof saveForUndo === 'function') {
                slider.noUiSlider.on('start', function(){ saveForUndo(); });
            }
            cuts = [newCut];
            updateTimestamps();
            try { suppressSliderSeek = false; } catch {}
        }
    }
}

// Compute step size from current zoom; lower step when zoomed in
function computeStepFromZoom(){
    const z = (typeof window !== 'undefined' && window.timelineZoom) ? window.timelineZoom : 1;
    const s = 0.1 / Math.max(1, z);
    return Math.max(0.01, +s.toFixed(3));
}

// Compute default cut length (seconds) based on video duration and current zoom.
// Baseline ~15% of duration, clamped to [1,10]s at 1x zoom; scales down by zoom.
function computeDefaultCutLength(){
    const z = (typeof window !== 'undefined' && window.timelineZoom) ? window.timelineZoom : 1;
    const dur = Math.max(0, Number(videoDuration) || 0);
    let base;
    if (dur <= 120) { // <= 2 min
        base = Math.max(2, Math.min(12, dur * 0.12));
    } else if (dur <= 600) { // <= 10 min
        base = Math.max(6, Math.min(25, dur * 0.08));
    } else if (dur <= 1800) { // <= 30 min
        base = Math.max(12, Math.min(60, dur * 0.05));
    } else if (dur <= 5400) { // <= 90 min
        base = Math.max(20, Math.min(120, dur * 0.03));
    } else { // > 90 min
        base = Math.max(30, Math.min(180, dur * 0.03));
    }
    const scaled = base / Math.max(1, z);
    // Clamp to reasonable range overall
    return Math.max(0.2, Math.min(180, +scaled.toFixed(3)));
}

function formatHMS(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
        return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    }
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function updateFinalDurationDisplay() {
    console.log('[updateFinalDurationDisplay] Called - cuts:', cuts.length, 'selectionMode:', selectionMode);
    if (!finalDurationEl) {
        console.log('[updateFinalDurationDisplay] ERROR: finalDurationEl is null/undefined! Returning early.');
        return;
    }
    let kept = 0;
    if (selectionMode === 'keep') {
        for (const c of cuts) { kept += Math.max(0, (Number(c.end)||0) - (Number(c.start)||0)); }
        kept = Math.max(0, Math.min(videoDuration||0, kept));
    } else {
        let removed = 0;
        for (const c of cuts) { removed += Math.max(0, (Number(c.end)||0) - (Number(c.start)||0)); }
        kept = Math.max(0, (Number(videoDuration)||0) - removed);
    }
    finalDurationEl.textContent = formatHMS(kept);
    console.log('[updateFinalDurationDisplay] About to call rebuildPreviewSegments, kept:', kept);
    rebuildPreviewSegments();
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '--';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(1)} ${units[i]}`;
}

function updateEstimatedSizeDisplay() {
    const estRatioEl = document.getElementById('est-size-ratio');
    const estCompEl = document.getElementById('est-size-compression');
    const actualEl = document.getElementById('actual-size'); // unchanged
    if (!origBytes || origBytes <= 0) { if (estRatioEl) estRatioEl.textContent='--'; if (estCompEl) estCompEl.textContent='--'; return; }

    // Compute kept seconds based on selectionMode
    let kept = 0;
    if (selectionMode === 'keep') {
        for (const c of cuts) { kept += Math.max(0, (Number(c.end)||0) - (Number(c.start)||0)); }
        kept = Math.max(0, Math.min(videoDuration||0, kept));
    } else {
        let removed = 0;
        for (const c of cuts) { removed += Math.max(0, (Number(c.end)||0) - (Number(c.start)||0)); }
        kept = Math.max(0, (Number(videoDuration)||0) - removed);
    }
    if (!Number.isFinite(videoDuration) || videoDuration <= 0 || kept <= 0.05) {
        if (estRatioEl) estRatioEl.textContent='--';
        if (estCompEl) estCompEl.textContent='--';
        return;
    }

    // 1) Length-ratio estimate (ignoring codec/resolution)
    const ratio = kept / videoDuration;
    const lenRatioBytes = Math.max(0, origBytes * ratio);
    if (estRatioEl) estRatioEl.textContent = formatBytes(lenRatioBytes);

    // 2) Compression estimate: apply known compression percentage based on chosen codec
    // We start from the length-ratio baseline and multiply by a codec-specific percentage
    // (relative to H.264 at comparable visual quality), then adjust for resolution and mode.
    const vSel = document.getElementById('video_codec');
    const resSel = document.getElementById('resolution');
    const modeSel = document.getElementById('mode');
    const mode = modeSel ? modeSel.value : 'quality';
    const targetCodec = (vSel?.value)||srcVCodec||'h264';
    const targetRes = (resSel?.value)||'original';

    // Per-codec expected bitrate ratios (lower means smaller output than H.264)
    const codecFactor = ({
        h264: 1.00,   // H.264 baseline
        hevc: 0.60,   // HEVC ~40% smaller than H.264 at similar quality
        vp9: 0.60,    // VP9 ~40% smaller
        av1: 0.50,    // AV1 ~50% smaller
        vp8: 1.15,    // VP8 typically larger than H.264
        prores: 6.0,  // Intra-only mezzanine, much larger
        dnxhd: 4.5,   // Intra-only mezzanine, much larger
    }[targetCodec]) ?? 1.0;

    // Resolution scaling factor (pixels ratio). If custom, use entered WxH vs source (unknown here, so we approximate from selection presets)
    const resMap = { original: 1, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360, '240p': 240 };
    const approxSrcH = 1080; // heuristic if unknown; still multiplied by length ratio
    let resFactor = 1.0;
    if (targetRes in resMap) {
        const th = resMap[targetRes];
        if (th !== 1) { resFactor = (th / approxSrcH); resFactor = Math.max(0.2, Math.min(1.5, resFactor)); }
    } else if (targetRes === 'custom') {
        const h = parseInt(document.getElementById('custom_height')?.value||'0',10);
        if (h>0) { resFactor = Math.max(0.2, Math.min(1.5, h / approxSrcH)); }
    }
    // Bitrate roughly scales with pixel count; we used linear height approx (width adjusts to aspect), clamp to sanity
    // Apply mode adjustments
    let modeFactor = 1.0;
    if (mode === 'quality') {
        const q = parseInt(document.getElementById('quality_percent')?.value||'100',10);
        if (Number.isFinite(q)) modeFactor = Math.max(0.2, Math.min(2.0, q/100));
    } else if (mode === 'crf') {
        const crf = parseInt(document.getElementById('crf_value')?.value||'28',10);
        // Approximate: each +6 CRF halves bitrate relative to CRF 22 (~visually lossless)
        const delta = crf - 22;
        modeFactor = Math.pow(0.5, delta/6);
        modeFactor = Math.max(0.1, Math.min(2.0, modeFactor));
    } else if (mode === 'size') {
        const mb = parseFloat(document.getElementById('target_size_mb')?.value||'0');
        if (mb>0) {
            // For size target, the compression estimate equals user target, bounded by kept duration min
            const bytes = mb * 1024 * 1024;
            if (estCompEl) estCompEl.textContent = formatBytes(bytes);
            return;
        }
    } else if (mode === 'copy') {
        // Copy mode keeps source codec and bitrate; only length ratio applies
        if (estCompEl) estCompEl.textContent = formatBytes(lenRatioBytes);
        return;
    }

    // Combine factors on top of length-ratio baseline
    const base = lenRatioBytes;
    let estBytes = Math.max(0, base * codecFactor * resFactor * modeFactor);

    // Adjust estimate to account for explicit audio bitrate selection
    try {
        const aSel = document.getElementById('audio_codec');
        const aPresetSel = document.getElementById('audio_bitrate_preset');
        const audioCodec = (aSel?.value) || 'aac';
        let audioKbps;
        if (aPresetSel && aPresetSel.value && aPresetSel.value !== 'original') {
            const v = parseInt(aPresetSel.value, 10);
            if (Number.isFinite(v) && v > 0) audioKbps = v;
        }
        if (!audioKbps) {
            // Heuristic defaults when 'Original' is selected
            const defMap = { aac: 128, mp3: 128, opus: 96, vorbis: 112, flac: 800 };
            audioKbps = defMap[audioCodec] || 128;
        }
        const audioBytes = Math.max(0, kept * (audioKbps * 1000 / 8));
        // Assume a default audio fraction within the codec-derived estimate and replace it with explicit audioBytes
        const defaultAudioFraction = (targetCodec === 'prores' || targetCodec === 'dnxhd') ? 0.02 : 0.08;
        const estVideoPortion = Math.max(0, estBytes * (1 - defaultAudioFraction));
        estBytes = estVideoPortion + audioBytes;
    } catch {}

    if (estCompEl) estCompEl.textContent = formatBytes(estBytes);
}

function initializeApp(duration, filename) {
    console.log('[initializeApp] Setting videoDuration to:', duration, 'filename:', filename);
    videoDuration = duration || 0;
    videoFilename = filename || "";

    slider = document.getElementById("timeline-slider");
    // Right-click on a cut range to delete it
    if (slider) {
        slider.addEventListener('contextmenu', handleCutDeleteContextMenu);
        // Bind once: clicking near a cut boundary or on a handle snaps to that frame
        if (!slider.dataset.seekHeadClickBound){
            ['click','pointerdown','mousedown'].forEach(evt => {
                slider.addEventListener(evt, handleTimelineClickSeek, true);
            });
            slider.dataset.seekHeadClickBound = '1';
        }
        // Hover tooltip that shows segment duration under mouse (works for filled and unfilled)
        setupSliderHoverTooltip();
    }
    timestampsDiv = document.getElementById("timestamps");
    video = document.getElementById("video");
    finalDurationEl = document.getElementById("final-duration-text");
    // Selection mode wiring
    const selModeEl = document.getElementById('selection-mode');
    if (selModeEl) {
        const applySelMode = ()=>{ selectionMode = selModeEl.value === 'keep' ? 'keep' : 'cut'; updateTimestamps(); };
        selModeEl.addEventListener('change', applySelMode);
        applySelMode();
    }
    // Note: We lazily create the slider on first Add Cut so we don't need an initial start array.

    // Wire undo/redo buttons
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.addEventListener('click', undoCuts);
    if (btnRedo) btnRedo.addEventListener('click', redoCuts);
    refreshUndoRedoButtons();

    // Minimal zoom controls: +/- below the timeline; scales slider width
    const wrap = document.getElementById('timeline-wrap');
    const btnZoomIn = document.getElementById('zoom-in');
    const btnZoomOut = document.getElementById('zoom-out');
    let zoom = 1; // 1x baseline
    try { window.timelineZoom = zoom; } catch {}
    const MAX_WIDTH = 100000; // cap to avoid huge DOM sizes
    // Derive base width from wrapper (preferred) or existing slider width or fallback
    let baseWidth = 600;
    if (wrap && wrap.clientWidth) baseWidth = wrap.clientWidth;
    else if (slider && slider.offsetWidth) baseWidth = slider.offsetWidth;
    const applyZoom = () => {
        if (!slider) return;
        const width = Math.min(MAX_WIDTH, Math.max(baseWidth, baseWidth * zoom));
        slider.style.width = width + 'px';
        // Update slider step according to zoom for finer control
        if (slider.noUiSlider) {
            try { slider.noUiSlider.updateOptions({ step: computeStepFromZoom() }, false); } catch {}
        }
        try { window.timelineZoom = zoom; } catch {}
        // Center view on current playback time if possible
        if (wrap && videoDuration > 0) {
            const current = (video && Number.isFinite(video.currentTime)) ? video.currentTime : 0;
            const frac = Math.min(1, Math.max(0, current / videoDuration));
            const targetX = (slider.offsetWidth * frac) - (wrap.clientWidth / 2);
            wrap.scrollLeft = Math.max(0, Math.min(slider.offsetWidth - wrap.clientWidth, targetX));
        }
    };
    if (btnZoomIn) btnZoomIn.addEventListener('click', ()=>{ zoom = Math.min(50, zoom + 0.5); applyZoom(); });
    if (btnZoomOut) btnZoomOut.addEventListener('click', ()=>{ zoom = Math.max(1, zoom - 0.5); applyZoom(); });
    applyZoom();
    // After initial layout, adjust baseWidth once (in case wrapper width was 0 at parse time)
    setTimeout(()=>{
        if (wrap && wrap.clientWidth && Math.abs(wrap.clientWidth - baseWidth) > 5 && zoom === 1) {
            baseWidth = wrap.clientWidth;
            applyZoom();
        }
    },0);
    // Update base width on window resize when at 1x zoom
    window.addEventListener('resize', () => {
        if (!wrap) return;
        if (zoom === 1) {
            const w = wrap.clientWidth;
            if (w && Math.abs(w - baseWidth) > 5) {
                baseWidth = w;
                applyZoom();
            }
        }
    });

    // Compression mode toggles
    const modeSel = document.getElementById('mode');
    const optQ = document.getElementById('opt_quality');
    const optS = document.getElementById('opt_size');
    const optC = document.getElementById('opt_crf');
    const resSel = document.getElementById('resolution');
    const customRes = document.getElementById('custom-res');
    if (modeSel && optQ && optS && optC) {
        const applyMode = () => {
            const m = modeSel.value;
            optQ.style.display = (m === 'quality') ? 'block' : 'none';
            optS.style.display = (m === 'size') ? 'block' : 'none';
            optC.style.display = (m === 'crf') ? 'block' : 'none';
            // In copy mode, resolution/codec selections are irrelevant; still allow trim join copy
        };
        modeSel.addEventListener('change', () => { applyMode(); updateEstimatedSizeDisplay(); });
        applyMode();
    }
    if (resSel && customRes) {
        const applyRes = () => {
            customRes.style.display = (resSel.value === 'custom') ? 'inline-block' : 'none';
            updateEstimatedSizeDisplay();
        };
        resSel.addEventListener('change', applyRes);
        applyRes();
    }

    // Read original file info from meta and render original size
    try {
        const meta = document.querySelector('meta[name="video-info"]');
        if (meta) {
            origBytes = parseInt(meta.getAttribute('data-bytes') || '0', 10) || 0;
            sourceBitrateKbps = parseInt(meta.getAttribute('data-bitrate-kbps') || '0', 10) || 0;
            srcVCodec = (meta.getAttribute('data-src-vcodec') || 'h264');
            srcACodec = (meta.getAttribute('data-src-acodec') || 'aac');
            srcContainer = (meta.getAttribute('data-src-container') || 'mp4');
        }
    } catch {}
    const origSizeEl = document.getElementById('orig-size');
    if (origSizeEl) origSizeEl.textContent = formatBytes(origBytes);
    if (video) {
        video.addEventListener('loadedmetadata', () => {
            updateEstimatedSizeDisplay();
        });
    }

    // Set UI defaults to source values
    const vSel = document.getElementById('video_codec');
    const aSel = document.getElementById('audio_codec');
    const cSel = document.getElementById('container');
    if (vSel) vSel.value = srcVCodec;
    if (aSel) aSel.value = srcACodec;
    if (cSel) cSel.value = srcContainer;

    // Auto-pick Copy mode when nothing is changed vs source and resolution is Original
    // modeSel and resSel already defined above
    const autoPickCopyIfNoChange = () => {
        const sameV = (vSel?.value || '') === srcVCodec;
        const sameA = (aSel?.value || '') === srcACodec;
        const sameC = (cSel?.value || '') === srcContainer;
        const resIsOriginal = (resSel?.value || 'original') === 'original';
        if (sameV && sameA && sameC && resIsOriginal) {
            if (modeSel && modeSel.value !== 'copy') {
                modeSel.value = 'copy';
            }
        }
    };
    autoPickCopyIfNoChange();

    // Container filtering by selected video codec support
    const containerSupport = {
        h264: ['mp4', 'mov', 'mkv'],
        hevc: ['mp4', 'mov', 'mkv'],
        vp8: ['webm', 'mkv'],
        vp9: ['webm', 'mkv'],
        av1: ['webm', 'mkv'],
        prores: ['mov', 'mkv'],
        dnxhd: ['mov', 'mkv'],
    };
    function filterContainersForVideoCodec() {
        if (!vSel || !cSel) return;
        const allow = new Set(containerSupport[vSel.value] || ['mkv']);
        Array.from(cSel.options).forEach(opt => {
            const ok = allow.has(opt.value);
            opt.hidden = !ok;
        });
        // If current selection is hidden, choose first allowed
        if (cSel.selectedOptions.length && cSel.selectedOptions[0].hidden) {
            const firstAllowed = Array.from(cSel.options).find(o => !o.hidden);
            if (firstAllowed) cSel.value = firstAllowed.value;
        }
    }
    if (vSel && cSel) {
        vSel.addEventListener('change', () => {
            filterContainersForVideoCodec();
            filterAudioForContainer();
            autoPickCopyIfNoChange();
            updateEstimatedSizeDisplay();
        });
        cSel.addEventListener('change', () => { filterAudioForContainer(); autoPickCopyIfNoChange(); updateEstimatedSizeDisplay(); });
        filterContainersForVideoCodec();
    }

    // Audio filtering by container
    const audioSupport = {
        mp4: ['aac', 'mp3'],
        mov: ['aac', 'mp3'],
        webm: ['opus', 'vorbis'],
        mkv: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
    };
    function filterAudioForContainer() {
        if (!aSel || !cSel) return;
        const allow = new Set(audioSupport[cSel.value] || ['aac','mp3','opus','vorbis','flac']);
        Array.from(aSel.options).forEach(opt => {
            const ok = allow.has(opt.value);
            opt.hidden = !ok;
        });
        if (aSel.selectedOptions.length && aSel.selectedOptions[0].hidden) {
            const firstAllowed = Array.from(aSel.options).find(o => !o.hidden);
            if (firstAllowed) aSel.value = firstAllowed.value;
        }
    }
    filterAudioForContainer();

    // Listen to option field changes to refresh estimate
    const qp = document.getElementById('quality_percent');
    const ts = document.getElementById('target_size_mb');
    const ak = document.getElementById('audio_bitrate_preset');
    const cv = document.getElementById('crf_value');
    const cw = document.getElementById('custom_width');
    const ch = document.getElementById('custom_height');
    [qp, ts, ak, cv, cw, ch].forEach(el => { if (el) el.addEventListener('input', updateEstimatedSizeDisplay); });
    if (ak) ak.addEventListener('change', updateEstimatedSizeDisplay);

    // Initial final duration display (no cuts yet)
    updateFinalDurationDisplay();
    updateEstimatedSizeDisplay();

    // Crop feature removed

    // Preview elements
    previewState.sliderEl = document.getElementById('preview-slider');
    previewState.playBtn = document.getElementById('btn-preview-play');
    previewState.timeEl = document.getElementById('preview-time');
    console.log('[initializeApp] Preview elements:', {
        sliderEl: previewState.sliderEl ? 'found' : 'NOT FOUND',
        playBtn: previewState.playBtn ? 'found' : 'NOT FOUND',
        timeEl: previewState.timeEl ? 'found' : 'NOT FOUND'
    });
    if (previewState.sliderEl) {
        previewState.sliderEl.addEventListener('input', (e)=>{
            const v = parseFloat(e.target.value)||0;
            console.log('[preview-slider input] User moved slider to:', v);
            // If user scrubs while playing, pause to avoid jumpy playback
            if (previewState.playing) {
                console.log('[preview-slider input] Was playing, pausing first');
                finishPreviewPlayback(false);
            }
            seekPreviewToKept(v);
            updatePreviewTimeDisplay();
            updatePreviewPlayButton();
        });
    }
    if (previewState.playBtn) {
        previewState.playBtn.addEventListener('click', togglePreviewPlayback);
        // Initialize the button state based on current segments
        updatePreviewPlayButton();
    }
    // Crop feature removed: setupCropOverlay/getVideoContentBox/drawCropBox/layoutCropBoxToVideo/cssCropToSourcePixels

    // Wire live preview playback time skip handler
    if (video) {
        video.addEventListener('timeupdate', handlePreviewTimeUpdate);
    }

    // Initialize batch processing UI
    try { setupBatchUI(); } catch {}
    // Initialize multi-clip add/merge UI
    try { setupClipsUI(); } catch {}

    // Toggle batch panel visibility based on processing mode (single vs batch)
    try {
        const modeSel = document.getElementById('processing-mode');
        const batchPanel = document.getElementById('batch-panel');
        const singleUpload = document.getElementById('single-upload-section');
        if (modeSel && batchPanel) {
            // Restore saved mode
            try {
                const saved = localStorage.getItem('processingMode');
                if (saved === 'single' || saved === 'batch') {
                    modeSel.value = saved;
                }
            } catch {}
            const apply = () => {
                const isSingle = modeSel.value === 'single';
                batchPanel.style.display = isSingle ? 'none' : 'block';
                if (singleUpload) singleUpload.style.display = isSingle ? 'block' : 'none';
            };
            modeSel.addEventListener('change', () => {
                try { localStorage.setItem('processingMode', modeSel.value); } catch {}
                if (window._modeSwitchReloadInProgress) return;
                window._modeSwitchReloadInProgress = true;
                location.reload();
            });
            apply();
        }
    } catch {}

} // end initializeApp

function addCut(){
    if (!videoFilename || videoDuration <= 0) {
        alert("Please upload a video first.");
        return;
    }

    // Ensure local cuts mirror the current slider before computing defaults
    if (slider && slider.noUiSlider) {
        let values = slider.noUiSlider.get();
        if (!Array.isArray(values)) values = [values];
        if (values.length % 2 !== 0) values = values.slice(0, values.length - 1);
        const synced = [];
        for (let i = 0; i < values.length; i += 2) {
            const s = parseFloat(values[i]);
            const e = parseFloat(values[i+1]);
            if (Number.isFinite(s) && Number.isFinite(e) && e > s) synced.push({start:s, end:e});
        }
        cuts = synced.sort((a,b)=> a.start - b.start);
    }

    // Determine a sensible default new cut that does not overlap existing ones
    const defaultLen = computeDefaultCutLength();
    // Normalize current cuts: sort and clamp
    cuts = (cuts || []).map(c => ({
        start: Math.max(0, Math.min(videoDuration, Number(c.start) || 0)),
        end: Math.max(0, Math.min(videoDuration, Number(c.end) || 0)),
    })).filter(c => c.end > c.start + 0.05).sort((a,b) => a.start - b.start);

    let start = 0;
    let end = Math.min(defaultLen, videoDuration);
    if (cuts.length > 0) {
        const last = cuts[cuts.length - 1];
        start = Math.min(Math.max(last.end + 0.1, 0), Math.max(videoDuration - 0.1, 0));
        end = Math.min(start + defaultLen, videoDuration);
        if (end - start < 0.1) {
            // Not enough room after last, try placing before the first
            const first = cuts[0];
            end = Math.max(first.start - 0.1, 0);
            start = Math.max(end - defaultLen, 0);
        }
    }
    if (end - start < 0.1) {
        alert("No space left to add another cut. Adjust existing ranges first.");
        return;
    }

    if (slider && slider.noUiSlider) {
        console.log('[addCut] Adding cut - start:', start, 'end:', end, 'videoDuration:', videoDuration);
        saveForUndo();
        cuts.push({ start, end });
        updateSlider();
        // Auto-scroll to new cut start
        try {
            const wrap = document.getElementById('timeline-wrap');
            if (wrap && slider && videoDuration > 0) {
                const frac = Math.min(1, Math.max(0, start / videoDuration));
                const targetX = (slider.offsetWidth * frac) - (wrap.clientWidth / 2);
                wrap.scrollLeft = Math.max(0, Math.min(slider.offsetWidth - wrap.clientWidth, targetX));
            }
        } catch {}
        return;
    }

    // Lazily create slider on first cut
    if (slider) {
        console.log('[addCut] Creating first slider - range: 0 to', videoDuration, 'start:', start, 'end:', end);
        try { suppressSliderSeek = true; } catch {}
        noUiSlider.create(slider, {
            start: [start, end],
            connect: [false, true, false],
            range: { min: 0, max: videoDuration },
            step: computeStepFromZoom(),
            behaviour: 'tap-drag',
            tooltips: true,
        });

        slider.noUiSlider.on('update', function(values, handle){
            const val = parseFloat(values[handle]);
            if (Number.isFinite(val) && video && !suppressSliderSeek) {
                video.currentTime = val;
            }
            updateTimestamps();
        });

        // Save one snapshot for creation and future drag gestures
        saveForUndo();
        slider.noUiSlider.on('start', function(){ saveForUndo(); });

        cuts = [{ start, end }];
    updateTimestamps();
    refreshUndoRedoButtons();
        // Scroll to first cut
        try {
            const wrap2 = document.getElementById('timeline-wrap');
            if (wrap2 && slider && videoDuration > 0) {
                const frac = Math.min(1, Math.max(0, start / videoDuration));
                const targetX = (slider.offsetWidth * frac) - (wrap2.clientWidth / 2);
                wrap2.scrollLeft = Math.max(0, Math.min(slider.offsetWidth - wrap2.clientWidth, targetX));
            }
        } catch {}
        try { suppressSliderSeek = false; } catch {}
    }
}

function updateSlider(){
    console.log('[updateSlider] Called - videoDuration:', videoDuration, 'cuts:', cuts.length, 'cuts array:', cuts);
    if (!slider) return;

    // Normalize, sort and de-overlap slightly
    let normalized = (cuts || []).map(c => ({
        start: Math.max(0, Math.min(videoDuration, Number(c.start) || 0)),
        end: Math.max(0, Math.min(videoDuration, Number(c.end) || 0)),
    })).filter(c => c.end > c.start + 0.05).sort((a,b) => a.start - b.start);
    console.log('[updateSlider] After normalization - normalized:', normalized.length, 'filtered cuts');
    // Merge only true overlaps; keep adjacent ranges separate
    const EPS = 0.001;
    const merged = [];
    for (const c of normalized) {
        if (merged.length === 0) { merged.push(c); continue; }
        const prev = merged[merged.length - 1];
        if (c.start < prev.end - EPS) {
            // overlap
            prev.end = Math.max(prev.end, c.end);
        } else {
            merged.push(c);
        }
    }
    cuts = merged;

    const values = [];
    const connect = [false];
    cuts.forEach(c => {
        values.push(+c.start.toFixed(2), +c.end.toFixed(2));
        connect.push(true, false);
    });

    if (values.length === 0) {
        // No cuts remain: destroy slider UI and clear timestamps
        if (slider.noUiSlider) {
            try { slider.noUiSlider.destroy(); } catch {}
        }
        slider.innerHTML = '';
        if (timestampsDiv) timestampsDiv.innerHTML = '';
        updateFinalDurationDisplay();
        updateEstimatedSizeDisplay();
        refreshUndoRedoButtons();
        return;
    }
    // Ensure even number of handles and connect length = handles+1
    if (values.length % 2 !== 0) {
        values.pop();
        connect.pop();
    }

    // If slider exists but handle count changed, recreate slider for compatibility
    const current = slider.noUiSlider ? slider.noUiSlider.get() : [];
    const currentLen = Array.isArray(current) ? current.length : (current ? 1 : 0);
    const desiredLen = values.length;

    if (!slider.noUiSlider || currentLen !== desiredLen) {
        console.log('[updateSlider] Recreating slider - range: 0 to', videoDuration, 'values:', values);
        if (slider.noUiSlider) {
            slider.noUiSlider.destroy();
        }
        try { suppressSliderSeek = true; } catch {}
        noUiSlider.create(slider, {
            start: values,
            connect: connect,
            range: { min: 0, max: videoDuration },
            step: computeStepFromZoom(),
            behaviour: 'tap-drag',
            tooltips: true,
        });
        console.log('[updateSlider] Slider created with range 0-' + videoDuration);
        slider.noUiSlider.on('update', function(vals, handle){
            const val = parseFloat(vals[handle]);
            if (Number.isFinite(val) && video && !suppressSliderSeek) {
                video.currentTime = val;
            }
            updateTimestamps();
        });
        // Snapshot at drag start to enable undo of handle moves
        slider.noUiSlider.on('start', function(){ saveForUndo(); });
        // Initialize tooltips on segments
        updateConnectTooltips();
        try { suppressSliderSeek = false; } catch {}
    } else {
        console.log('[updateSlider] Updating existing slider - setting range 0-' + videoDuration, 'values:', values);
        try { suppressSliderSeek = true; } catch {}
        slider.noUiSlider.updateOptions({ start: values, connect: connect, range: { min: 0, max: videoDuration }, step: computeStepFromZoom() }, false);
        try { suppressSliderSeek = false; } catch {}
        updateConnectTooltips();
    }

    updateTimestamps();
    refreshUndoRedoButtons();
}

// Context menu handler to delete a cut by right-clicking inside its range on the slider
function handleCutDeleteContextMenu(e){
    if (!slider || !Array.isArray(cuts) || cuts.length === 0 || !Number.isFinite(videoDuration) || videoDuration <= 0) return;
    // Compute timeline value based on click position
    const rect = slider.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const frac = x / rect.width;
    if (!Number.isFinite(frac) || frac < 0 || frac > 1) return;
    const val = Math.min(videoDuration, Math.max(0, frac * videoDuration));
    // Find cut containing this value
    const idx = cuts.findIndex(c => val >= c.start && val <= c.end);
    if (idx >= 0) {
        e.preventDefault(); // avoid browser menu to enable quick second click
        const now = Date.now();
        if (lastContextDelete.idx === idx && (now - lastContextDelete.t) <= 550) {
            // Double right-click on the same cut: delete
            saveForUndo();
            cuts.splice(idx, 1);
            updateSlider();
            lastContextDelete = { idx: -1, t: 0 };
        } else {
            // First right-click: arm for double
            lastContextDelete = { idx, t: now };
        }
    }
}

// ---------- Undo/Redo helpers ----------
function deepCopyCuts(arr){ return (arr||[]).map(c=>({start:+c.start, end:+c.end})); }
function refreshUndoRedoButtons(){
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.disabled = undoStack.length === 0;
    if (btnRedo) btnRedo.disabled = redoStack.length === 0;
}
function saveForUndo(){
    undoStack.push(deepCopyCuts(cuts));
    redoStack = [];
    refreshUndoRedoButtons();
}
function applyCutsState(state){
    cuts = deepCopyCuts(state||[]);
    updateSlider();
}
function undoCuts(){
    if (undoStack.length === 0) return;
    const current = deepCopyCuts(cuts);
    const prev = undoStack.pop();
    redoStack.push(current);
    applyCutsState(prev);
    refreshUndoRedoButtons();
}
function redoCuts(){
    if (redoStack.length === 0) return;
    const current = deepCopyCuts(cuts);
    const next = redoStack.pop();
    undoStack.push(current);
    applyCutsState(next);
    refreshUndoRedoButtons();
}

function updateTimestamps(){
    console.log('[updateTimestamps] Called');
    if (!slider || !slider.noUiSlider) return;

    let values = slider.noUiSlider.get();
    if (!Array.isArray(values)) values = [values];
    // Guard against odd number of values
    if (values.length % 2 !== 0) values = values.slice(0, values.length - 1);

    // Optionally render text if the container exists
    if (timestampsDiv) {
        let html = '';
        for (let i = 0; i < values.length; i += 2) {
            const sVal = parseFloat(values[i]);
            const eVal = parseFloat(values[i + 1]);
            if (!Number.isFinite(sVal) || !Number.isFinite(eVal)) continue;
            const s = sVal.toFixed(1);
            const e = eVal.toFixed(1);
            html += `<span style="margin-right:15px;">Cut ${i / 2 + 1}: ${s}s → ${e}s</span>`;
        }
        timestampsDiv.innerHTML = html;
    }

    // Always sync internal cuts from slider values
    cuts = [];
    for (let i = 0; i < values.length; i += 2) {
        const s = parseFloat(values[i]);
        const e = parseFloat(values[i + 1]);
        if (Number.isFinite(s) && Number.isFinite(e)) {
            cuts.push({ start: s, end: e });
        }
    }

    updateFinalDurationDisplay();
    updateEstimatedSizeDisplay();
    // Refresh segment hover tooltips (durations)
    updateConnectTooltips();
}

// Show duration tooltips on each selected segment (works for both cut and keep modes)
function updateConnectTooltips(){
    try {
        if (!slider || !slider.noUiSlider) return;
        const connects = slider.querySelectorAll('.noUi-connect');
        if (!connects || !connects.length) return;
        let values = slider.noUiSlider.get();
        if (!Array.isArray(values)) values = [values];
        if (values.length % 2 !== 0) values = values.slice(0, values.length - 1);
        
        // Each cut range corresponds to a visible connect element
        // The connect array has one element for each segment in the connect option
        let connectIndex = 0;
        for (let i=0;i<values.length;i+=2){
            const s = parseFloat(values[i]);
            const e = parseFloat(values[i+1]);
            if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
            const dur = Math.max(0, e - s);
            
            // Find the next visible connect element (one with class 'noUi-connect' that's actually visible)
            while (connectIndex < connects.length) {
                const el = connects[connectIndex];
                connectIndex++;
                // Check if this connect element is actually visible/active (has width)
                if (el && el.offsetWidth > 0) {
                    const text = `${formatHMS(dur)}`;
                    el.title = text;
                    el.setAttribute('aria-label', text);
                    break;
                }
            }
        }
    } catch {}
}

// Dynamic hover tooltip on the whole slider: shows duration of the segment under the mouse
function setupSliderHoverTooltip(){
    if (!slider) return;
    if (slider.dataset.hoverTooltipBound) return;
    const onMove = (e) => {
        if (!slider || !slider.noUiSlider || !Number.isFinite(videoDuration) || videoDuration <= 0) return;
        const rect = slider.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const t = (x / rect.width) * videoDuration;
        let vals = slider.noUiSlider.get();
        if (!Array.isArray(vals)) vals = [vals];
        if (vals.length % 2 !== 0) vals = vals.slice(0, vals.length - 1);
        const bounds = [0];
        for (let i=0;i<vals.length;i++){ const v = parseFloat(vals[i]); if (Number.isFinite(v)) bounds.push(Math.max(0, Math.min(videoDuration, v))); }
        bounds.push(videoDuration);
        bounds.sort((a,b)=>a-b);
        let dur = 0;
        for (let i=0;i<bounds.length-1;i++){
            if (t >= bounds[i] && t <= bounds[i+1]){ dur = Math.max(0, bounds[i+1] - bounds[i]); break; }
        }
        // Update title only if changed to reduce flicker
        const text = formatHMS(dur);
        if (slider.getAttribute('data-last-title') !== text){
            slider.title = text;
            slider.setAttribute('data-last-title', text);
        }
    };
    const onLeave = () => { if (slider) { slider.removeAttribute('title'); slider.removeAttribute('data-last-title'); } };
    slider.addEventListener('mousemove', onMove, true);
    slider.addEventListener('mouseenter', onMove, true);
    slider.addEventListener('mouseleave', onLeave, true);
    slider.dataset.hoverTooltipBound = '1';
}

// ---------------- Preview of Kept Segments ----------------
function rebuildPreviewSegments(){
    // Compute kept segments based on selectionMode
    console.log('[rebuildPreviewSegments] Called with videoDuration:', videoDuration, 'cuts:', cuts, 'selectionMode:', selectionMode);
    if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
        console.log('[rebuildPreviewSegments] Invalid videoDuration, returning early');
        return;
    }
    const norm = (cuts||[]).map(c=>({start:Math.max(0,Math.min(videoDuration,c.start)), end:Math.max(0,Math.min(videoDuration,c.end))}))
        .filter(c=>c.end>c.start+0.01).sort((a,b)=>a.start-b.start);
    console.log('[rebuildPreviewSegments] Normalized cuts:', norm);
    const kept = [];
    if (selectionMode === 'keep'){
        for (const r of norm){ kept.push({start:r.start, end:r.end}); }
    } else {
        let cursor = 0;
        for (const r of norm){
            if (r.start > cursor){ kept.push({start:cursor, end:r.start}); }
            cursor = Math.max(cursor, r.end);
        }
        if (cursor < videoDuration){ kept.push({start:cursor, end:videoDuration}); }
    }
    console.log('[rebuildPreviewSegments] Kept segments before filtering:', kept);
    // Filter out tiny segments
    const filtered = kept.filter(k=>k.end - k.start > 0.05);
    let accum = 0;
    filtered.forEach(seg=>{ seg.dur = seg.end - seg.start; seg.accumStart = accum; accum += seg.dur; });
    previewState.segments = filtered;
    previewState.totalKept = accum;
    console.log('[rebuildPreviewSegments] Final segments:', previewState.segments, 'totalKept:', previewState.totalKept);
    if (previewState.sliderEl){
        previewState.sliderEl.max = (accum > 0 ? accum : 0).toFixed(2);
        if (parseFloat(previewState.sliderEl.value) > accum){ previewState.sliderEl.value = '0'; }
        console.log('[rebuildPreviewSegments] Updated slider max to:', previewState.sliderEl.max, 'value:', previewState.sliderEl.value);
    } else {
        console.log('[rebuildPreviewSegments] Warning: previewState.sliderEl is null!');
    }
    updatePreviewTimeDisplay();
    updatePreviewPlayButton();
}

function keptToRealTime(keptPos){
    // Map kept timeline position to real video time
    console.log('[keptToRealTime] Input keptPos:', keptPos, 'segments:', previewState.segments.length);
    for (const seg of previewState.segments){
        if (keptPos >= seg.accumStart && keptPos < seg.accumStart + seg.dur){
            const offset = keptPos - seg.accumStart;
            const realT = seg.start + offset;
            console.log('[keptToRealTime] Found in segment:', seg, 'returning:', realT);
            return realT;
        }
    }
    if (previewState.segments.length){
        const last = previewState.segments[previewState.segments.length-1];
        console.log('[keptToRealTime] Past all segments, returning last.end:', last.end);
        return last.end; // end
    }
    console.log('[keptToRealTime] No segments, returning 0');
    return 0;
}

function realTimeToKept(realT){
    for (const seg of previewState.segments){
        if (realT >= seg.start && realT < seg.end){
            return seg.accumStart + (realT - seg.start);
        }
        if (realT < seg.start) return seg.accumStart; // before this kept seg
    }
    return previewState.totalKept;
}

function seekPreviewToKept(keptPos){
    previewState.currentKeptPos = Math.max(0, Math.min(previewState.totalKept, keptPos));
    const realT = keptToRealTime(previewState.currentKeptPos);
    console.log('[seekPreviewToKept] Seeking to keptPos:', keptPos, '-> realTime:', realT);
    if (video && Number.isFinite(realT)) {
        video.currentTime = realT;
        console.log('[seekPreviewToKept] Set video.currentTime to:', video.currentTime);
    } else {
        console.log('[seekPreviewToKept] Failed - video:', video, 'realT:', realT);
    }
}

function updatePreviewTimeDisplay(){
    if (!previewState.timeEl) return;
    const pos = previewState.currentKeptPos;
    const text = formatHMS(pos) + (previewState.totalKept>0? ' / ' + formatHMS(previewState.totalKept):'');
    previewState.timeEl.textContent = text;
    console.log('[updatePreviewTimeDisplay] Updated to:', text, 'currentKeptPos:', pos, 'totalKept:', previewState.totalKept);
}

function updatePreviewPlayButton(){
    const btn = previewState.playBtn;
    if (!btn) return;
    const hasKept = previewState.totalKept > 0.001 && Array.isArray(previewState.segments) && previewState.segments.length > 0;
    // Disable when nothing to preview
    btn.disabled = !hasKept;
    if (!hasKept){
        btn.textContent = '▶';
        btn.title = 'Play (no kept segments)';
        btn.setAttribute('aria-pressed','false');
        return;
    }
    if (previewState.playing){
        btn.textContent = '⏸';
        btn.title = 'Pause (Space)';
        btn.setAttribute('aria-pressed','true');
    } else {
        btn.textContent = '▶';
        btn.title = 'Play (Space)';
        btn.setAttribute('aria-pressed','false');
    }
}

function togglePreviewPlayback(){
    console.log('[togglePreviewPlayback] Called, playing:', previewState.playing, 'totalKept:', previewState.totalKept);
    if (!previewState.playBtn || !video) {
        console.log('[togglePreviewPlayback] Missing playBtn or video');
        return;
    }
    if (!previewState.playing) {
        if (!previewState.totalKept) rebuildPreviewSegments();
        if (!previewState.totalKept) {
            console.log('[togglePreviewPlayback] No kept segments to play');
            return;
        }
        // If at end, restart
        if (Math.abs(previewState.currentKeptPos - previewState.totalKept) < 0.01) {
            previewState.currentKeptPos = 0;
            seekPreviewToKept(0);
        }
        console.log('[togglePreviewPlayback] Starting playback at keptPos:', previewState.currentKeptPos);
        previewState.playing = true;
        updatePreviewPlayButton();
        // Ensure real time is inside a kept segment
        const realWithin = previewState.segments.some(seg => video.currentTime >= seg.start && video.currentTime < seg.end);
        if (!realWithin) {
            console.log('[togglePreviewPlayback] Video time not in kept segment, seeking');
            seekPreviewToKept(previewState.currentKeptPos);
        }
        video.play().catch((e)=>{ console.error('[togglePreviewPlayback] Play failed:', e); });
    } else {
        console.log('[togglePreviewPlayback] Pausing playback');
        finishPreviewPlayback(false); // pause only
    }
}

function finishPreviewPlayback(resetToStart=true){
    // Always pause the actual video playback
    if (video && typeof video.pause === 'function') {
        try { video.pause(); } catch {}
    }
    if (!previewState.playing) return;
    previewState.playing = false;
    updatePreviewPlayButton();
    if (resetToStart) {
        previewState.currentKeptPos = previewState.totalKept; // stay at end position
        updatePreviewTimeDisplay();
    }
}

function handlePreviewTimeUpdate(){
    if (!previewState.playing || !video) return;
    const t = video.currentTime;
    // Find current kept segment
    let seg = null; let segIdx = -1;
    for (let i=0;i<previewState.segments.length;i++){
        const s = previewState.segments[i];
        if (t >= s.start && t < s.end){ seg = s; segIdx = i; break; }
    }
    if (!seg){
        // We're in a cut portion (likely due to seek). Jump to next kept segment or end.
        console.log('[handlePreviewTimeUpdate] Not in kept segment at t:', t, 'looking for next...');
        for (let i=0;i<previewState.segments.length;i++){
            if (t < previewState.segments[i].start){
                console.log('[handlePreviewTimeUpdate] Jumping to segment', i);
                seekPreviewToKept(previewState.segments[i].accumStart);
                return;
            }
        }
        console.log('[handlePreviewTimeUpdate] Past all segments, finishing playback');
        finishPreviewPlayback();
        return;
    }
    // Update kept position
    previewState.currentKeptPos = seg.accumStart + (t - seg.start);
    // If crossed segment end (can happen if timeupdate late), move to next
    if (t >= seg.end - 0.005){
        if (segIdx + 1 < previewState.segments.length){
            console.log('[handlePreviewTimeUpdate] Reached end of segment', segIdx, 'moving to next');
            seekPreviewToKept(previewState.segments[segIdx+1].accumStart);
            return;
        } else {
            console.log('[handlePreviewTimeUpdate] Reached end of last segment');
            finishPreviewPlayback();
            return;
        }
    }
    // Update slider/time display throttled via flag
    if (previewState.sliderEl && !previewState.suppressSlider){
        previewState.suppressSlider = true;
        previewState.sliderEl.value = previewState.currentKeptPos.toFixed(3);
        updatePreviewTimeDisplay();
        setTimeout(()=>{ previewState.suppressSlider = false; }, 50); // limit updates to ~20fps
    }
}

// Rebuild segments whenever cuts change implicitly via slider update or manual changes.
// updateFinalDurationDisplay already calls rebuildPreviewSegments, but we also update on seeking user interactions.

function submitCuts(){
    if (isProcessing) { alert("Processing already in progress. Please wait..."); return; }
    // If in Batch mode, delegate to batch starter so this button becomes universal
    try {
        const procModeSel = document.getElementById('processing-mode');
        if (procModeSel && procModeSel.value === 'batch') {
            startBatchProcessFromUI();
            return;
        }
    } catch {}
    // Decide: multi-clip merge vs single-file process
    const clipCount = (clipsState && Array.isArray(clipsState.items)) ? clipsState.items.length : 0;
    if (clipCount >= 2) {
        // Multi-clip path: persist current edits to the active clip, build payload and call /merge/start_clips
        try {
            // Persist current edits from editor into current clip
            if (clipsState.currentId && slider && slider.noUiSlider) {
                const clip = clipsState.items.find(x=>x.id===clipsState.currentId);
                if (clip) {
                    let values = slider.noUiSlider.get();
                    if (!Array.isArray(values)) values = [values];
                    if (values.length % 2 !== 0) values = values.slice(0, values.length-1);
                    clip.cuts = [];
                    for (let i=0;i<values.length;i+=2){
                        const s = parseFloat(values[i]); const e = parseFloat(values[i+1]);
                        if (Number.isFinite(s) && Number.isFinite(e) && e>s) clip.cuts.push([s,e]);
                    }
                    clip.selectionMode = selectionMode;
                }
            }
        } catch {}

        // Gather settings
        const modeSel = document.getElementById('mode');
        const modeVal = modeSel ? modeSel.value : 'quality';
        const payload = {
            clips: clipsState.items.map(c=>({ filename: c.filename, cuts: Array.isArray(c.cuts)?c.cuts:[], selection_mode: (c.selectionMode||'cut') })),
            mode: modeVal,
            quality_percent: parseInt(document.getElementById('quality_percent')?.value || '100',10),
            target_size_mb: parseFloat(document.getElementById('target_size_mb')?.value || '0') || undefined,
            crf: parseInt(document.getElementById('crf_value')?.value || '28',10),
            resolution: document.getElementById('resolution')?.value || 'original',
            width: (document.getElementById('custom_width')?.value||'').trim() || undefined,
            height: (document.getElementById('custom_height')?.value||'').trim() || undefined,
            video_codec: document.getElementById('video_codec')?.value || 'h264',
            audio_codec: document.getElementById('audio_codec')?.value || 'aac',
            container: document.getElementById('container')?.value || 'mp4'
        };

        isProcessing = true;
        const cancelBtn = document.getElementById('btn-cancel');
        if (cancelBtn) cancelBtn.style.display = 'inline-block';
        fetch('/merge/start_clips', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
            .then(r=>r.json().then(js=>({ok:r.ok, js})))
            .then(({ok, js})=>{
                if (!ok) throw new Error(js.error || 'Failed to start merge');
                mergeState.jobId = js.job_id;
                startMergeProgress(js.job_id);
            })
            .catch(err=>{ console.error('Merge start failed:', err); isProcessing=false; alert('Failed to start merge: '+err.message); const cancelBtn = document.getElementById('btn-cancel'); if (cancelBtn) cancelBtn.style.display='none'; });
        return;
    }

    // Single-file path (existing behavior)
    isProcessing = true;
    const cancelBtn = document.getElementById('btn-cancel');
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    const formData = new FormData();
    formData.append('existing_file', videoFilename);
    formData.append('cuts', JSON.stringify(cuts.map(c=>[c.start, c.end])));
    formData.append('selection_mode', selectionMode);
    const modeSel = document.getElementById('mode');
    let mode = modeSel ? modeSel.value : 'quality';
    formData.append('mode', mode);

    // Audio preset
    const audioPresetEl = document.getElementById('audio_bitrate_preset');
    const audioPreset = audioPresetEl ? audioPresetEl.value : 'original';
    if (audioPreset === 'original') {
        formData.append('audio_bitrate_preset', 'original');
    } else if (audioPreset) {
        formData.append('audio_kbps', audioPreset);
    }

    if (mode === 'copy') {
        // If user wants audio re-encode in copy mode, switch to CRF 28
        if (audioPreset && audioPreset !== 'original') {
            mode = 'crf';
            formData.set('mode', 'crf');
            formData.append('crf', '28');
        }
    } else if (mode === 'quality') {
        const q = parseInt(document.getElementById('quality_percent')?.value || '75', 10);
        formData.append('quality_percent', isNaN(q) ? '75' : String(Math.max(1, Math.min(100, q))));
    } else if (mode === 'size') {
        const mb = parseFloat(document.getElementById('target_size_mb')?.value || '20');
        formData.append('target_size_mb', isNaN(mb) ? '20' : String(Math.max(1, mb)));
        // audio bitrate already appended if numeric
    } else {
        const crf = parseInt(document.getElementById('crf_value')?.value || '28', 10);
        formData.append('crf', isNaN(crf) ? '28' : String(Math.max(18, Math.min(35, crf))));
    }

    // Resolution
    const resSel2 = document.getElementById('resolution');
    const resVal = resSel2 ? resSel2.value : 'original';
    formData.append('resolution', resVal);
    if (resVal === 'custom') {
        const w = parseInt(document.getElementById('custom_width')?.value || '0', 10);
        const h = parseInt(document.getElementById('custom_height')?.value || '0', 10);
        if (w>0 && h>0) { formData.append('width', String(w)); formData.append('height', String(h)); }
    }

    // Codecs/container
    formData.append('video_codec', document.getElementById('video_codec')?.value || 'h264');
    formData.append('audio_codec', document.getElementById('audio_codec')?.value || 'aac');
    formData.append('container', document.getElementById('container')?.value || 'mp4');

    fetch('/', {method:'POST', body:formData})
        .then(()=>{ startProgress(); })
        .catch(err=>{ console.error('Submit failed:', err); isProcessing=false; alert('Failed to start processing: '+err.message); const cancelBtn = document.getElementById('btn-cancel'); if (cancelBtn) cancelBtn.style.display='none'; });
}

// Poll merge job progress and update UI similarly to single-file progress
function startMergeProgress(jobId){
    let bar = document.getElementById("bar");
    const previewWrap = document.getElementById('preview');
    const previewVideo = document.getElementById('preview-video');
    const actions = document.getElementById('actions');
    const btnDownload = document.getElementById('btn-download');
    let actualSizeEl = document.getElementById("actual-size");
    const cancelBtn = document.getElementById('btn-cancel');
    // ETA line shared with single
    let etaLine = document.getElementById('eta-line');
    if (!etaLine) {
        const pb = document.getElementById('progressBar');
        if (pb) {
            etaLine = document.createElement('div');
            etaLine.id = 'eta-line';
            etaLine.style.fontSize = '13px';
            etaLine.style.margin = '4px 0 4px 0';
            etaLine.style.color = '#555';
            pb.parentNode.insertBefore(etaLine, pb);
        }
    }
    startTimeMs = Date.now();
    etaHistory = [];

    function formatETA(ms){
        if (ms < 0 || !isFinite(ms)) return '';
        const sec = Math.round(ms/1000);
        const m = Math.floor(sec/60);
        const s = sec % 60;
        if (m > 59) { const h = Math.floor(m/60); const m2 = m % 60; return `${h}h ${m2}m`; }
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function update(){
        fetch(`/merge/status?job_id=${encodeURIComponent(jobId)}`)
            .then(r=>r.json())
            .then(data=>{
                if (bar){ bar.style.width = (data.percent||0) + "%"; bar.innerText = (data.percent||0) + "%"; }
                // ETA
                if (etaLine){
                    if (data.done){ etaLine.textContent = 'Completed'; }
                    else if (data.percent>0 && data.percent<100){
                        if (!etaHistory.length || etaHistory[etaHistory.length-1].percent !== data.percent) {
                            etaHistory.push({percent: data.percent, time: Date.now()});
                            if (etaHistory.length > 10) etaHistory.shift();
                        }
                        let avgMsPerPct = null;
                        if (etaHistory.length >= 2) {
                            let totalMs=0,totalPct=0;
                            for (let i=1;i<etaHistory.length;i++){ const dt = etaHistory[i].time-etaHistory[i-1].time; const dp = etaHistory[i].percent-etaHistory[i-1].percent; if (dp>0){ totalMs+=dt; totalPct+=dp; } }
                            if (totalPct>0) avgMsPerPct = totalMs/totalPct;
                        }
                        if (avgMsPerPct && data.percent<100){ etaLine.textContent = 'Estimated time remaining: ' + formatETA(avgMsPerPct*(100-data.percent)); }
                        else { etaLine.textContent = 'Estimating…'; }
                    } else if ((data.percent||0)===0) { etaLine.textContent='Preparing…'; }
                }
                // Step-by-step log under ETA
                try {
                    let steps = document.getElementById('eta-steps');
                    if (!steps) {
                        const pb = document.getElementById('progressBar');
                        steps = document.createElement('div');
                        steps.id = 'eta-steps';
                        steps.style.fontSize = '12px';
                        steps.style.margin = '4px 0 4px 0';
                        steps.style.color = '#444';
                        steps.style.maxHeight = '140px';
                        steps.style.overflowY = 'auto';
                        if (pb && etaLine && etaLine.parentNode){ etaLine.parentNode.insertBefore(steps, pb.nextSibling); }
                    }
                    if (Array.isArray(data.messages)){
                        const last = data.messages.slice(-80);
                        steps.innerHTML = last.map(line => `<div>${String(line).replace(/</g,'&lt;')}</div>`).join('');
                        steps.scrollTop = steps.scrollHeight;
                    }
                } catch {}

                if (data.done){
                    isProcessing = false;
                    mergeState.jobId = null;
                    if (cancelBtn) cancelBtn.style.display = 'none';
                    if (data.error){ alert('Error: ' + data.error); }
                    else {
                        const fileUrl = "/download?file=" + encodeURIComponent(data.output);
                        if (previewWrap && previewVideo){ previewWrap.style.display='block'; previewVideo.src = fileUrl; }
                        if (actions && btnDownload){ actions.style.display='flex'; btnDownload.onclick = ()=>{ window.location.href = fileUrl; }; }
                        if (actualSizeEl && data.output_size){ actualSizeEl.textContent = formatBytes(data.output_size); }
                    }
                } else if (data.processing || (data.percent||0) < 100){
                    setTimeout(update, 600);
                } else {
                    // Fallback
                    isProcessing = false;
                    mergeState.jobId = null;
                }
            })
            .catch(err=>{
                console.error('Merge status failed:', err);
                setTimeout(update, 1500);
            });
    }
    update();
}

function startProgress() {
    let bar = document.getElementById("bar");
    let dlLink = document.getElementById("dl_link");
    const previewWrap = document.getElementById('preview');
    const previewVideo = document.getElementById('preview-video');
    const actions = document.getElementById('actions');
    const btnDownload = document.getElementById('btn-download');
    let actualSizeEl = document.getElementById("actual-size");
    const cancelBtn = document.getElementById('btn-cancel');
    // Create or get ETA line
    let etaLine = document.getElementById('eta-line');
    if (!etaLine) {
        const pb = document.getElementById('progressBar');
        if (pb) {
            etaLine = document.createElement('div');
            etaLine.id = 'eta-line';
            etaLine.style.fontSize = '13px';
            etaLine.style.margin = '4px 0 4px 0';
            etaLine.style.color = '#555';
            pb.parentNode.insertBefore(etaLine, pb); // insert above progress bar
        }
    }
    startTimeMs = Date.now();
    etaHistory = [];

    function formatETA(ms){
        if (ms < 0 || !isFinite(ms)) return '';
        const sec = Math.round(ms/1000);
        const m = Math.floor(sec/60);
        const s = sec % 60;
        if (m > 59) {
            const h = Math.floor(m/60);
            const m2 = m % 60;
            return `${h}h ${m2}m`;
        }
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function update() {
        fetch("/progress").then(r => r.json()).then(data => {
            bar.style.width = data.percent + "%";
            bar.innerText = data.percent + "%";
            // ETA calculation
            if (etaLine) {
                if (data.done) {
                    etaLine.textContent = 'Completed';
                } else if (data.percent > 0 && data.percent < 100) {
                    // Track time per percent increment
                    if (!etaHistory.length || etaHistory[etaHistory.length-1].percent !== data.percent) {
                        etaHistory.push({percent: data.percent, time: Date.now()});
                        // Keep only last 10 increments for smoothing
                        if (etaHistory.length > 10) etaHistory.shift();
                    }
                    // Calculate average ms per percent
                    let avgMsPerPct = null;
                    if (etaHistory.length >= 2) {
                        let totalMs = 0, totalPct = 0;
                        for (let i=1; i<etaHistory.length; ++i) {
                            const dt = etaHistory[i].time - etaHistory[i-1].time;
                            const dp = etaHistory[i].percent - etaHistory[i-1].percent;
                            if (dp > 0) {
                                totalMs += dt;
                                totalPct += dp;
                            }
                        }
                        if (totalPct > 0) avgMsPerPct = totalMs / totalPct;
                    }
                    if (avgMsPerPct && data.percent < 100) {
                        const remainingPct = 100 - data.percent;
                        const remainingMs = avgMsPerPct * remainingPct;
                        etaLine.textContent = 'Estimated time remaining: ' + formatETA(remainingMs);
                    } else {
                        etaLine.textContent = 'Estimating…';
                    }
                } else if (data.percent === 0) {
                    etaLine.textContent = 'Preparing…';
                }
            }
            // Step-by-step log under ETA (single-file)
            try {
                let steps = document.getElementById('eta-steps');
                if (!steps) {
                    const pb = document.getElementById('progressBar');
                    steps = document.createElement('div');
                    steps.id = 'eta-steps';
                    steps.style.fontSize = '12px';
                    steps.style.margin = '4px 0 4px 0';
                    steps.style.color = '#444';
                    steps.style.maxHeight = '140px';
                    steps.style.overflowY = 'auto';
                    if (pb && etaLine && etaLine.parentNode){ etaLine.parentNode.insertBefore(steps, pb.nextSibling); }
                }
                if (Array.isArray(data.messages)){
                    const last = data.messages.slice(-80);
                    steps.innerHTML = last.map(line => `<div>${String(line).replace(/</g,'&lt;')}</div>`).join('');
                    steps.scrollTop = steps.scrollHeight;
                }
            } catch {}

            if (data.done) {
                isProcessing = false;
                if (cancelBtn) cancelBtn.style.display = 'none';
                if (data.error) {
                    alert("Error: " + data.error);
                } else {
                    const fileUrl = "/download?file=" + encodeURIComponent(data.output);
                    // Show preview
                    if (previewWrap && previewVideo) {
                        previewWrap.style.display = 'block';
                        previewVideo.src = fileUrl;
                    }
                    if (actions && btnDownload && dlLink) {
                        actions.style.display = 'flex';
                        dlLink.href = fileUrl;
                        btnDownload.onclick = () => { window.location.href = fileUrl; };
                    }
                    if (actualSizeEl && data.output_size) {
                        actualSizeEl.textContent = formatBytes(data.output_size);
                    }
                }
            } else if (data.processing) {
                setTimeout(update, 500);
            } else {
                isProcessing = false;
            }
        }).catch(err => {
            console.error("Progress check failed:", err);
            isProcessing = false;
            if (cancelBtn) cancelBtn.style.display = 'none';
            setTimeout(update, 2000);
        });
    }
    update();
}

function cancelProcessing(){
    if (!isProcessing) return;
    // If a merge job is active, cancel that; else cancel single-file processing
    if (mergeState && mergeState.jobId){
        fetch(`/merge/cancel?job_id=${encodeURIComponent(mergeState.jobId)}`, {method:'POST'})
            .then(()=>{})
            .catch(err=>{ console.error('Merge cancel failed', err); });
    } else {
        fetch('/cancel', {method:'POST'}).then(()=>{
            // Progress polling will pick up canceled state
        }).catch(err=>{ console.error('Cancel failed', err); });
    }
}

// ---------------- Batch Processing ----------------
let batchState = { batchId: null, files: [], items: [], polling: null, currentFile: null, presetMode: 'single' };

function setupBatchUI(){
    // Idempotent binding: avoid attaching listeners twice
    const batchPanelEl = document.getElementById('batch-panel');
    if (batchPanelEl && batchPanelEl.dataset.batchUiBound === '1') return;
    const input = document.getElementById('batch-files');
    const btnUpload = document.getElementById('btn-batch-upload');
    const btnCancel = document.getElementById('btn-batch-cancel');
    const list = document.getElementById('batch-files-list');
    const jobsWrap = document.getElementById('batch-jobs');
    const overall = document.getElementById('batch-overall');
    const overallBar = document.getElementById('batch-overall-bar');
    const concurrencySel = document.getElementById('batch-concurrency');
    const presetModeSel = document.getElementById('batch-preset-mode');
    const helpText = document.getElementById('batch-help-text');
    if (!input || !btnUpload || !btnCancel || !list || !jobsWrap || !overall || !overallBar || !concurrencySel || !presetModeSel || !helpText) return;
    if (batchPanelEl) batchPanelEl.dataset.batchUiBound = '1';

    // Helper: create or update thumbnail for an item
    async function ensureBatchThumb(item){
        if (!item || item.thumb) return item.thumb;
        return new Promise((resolve)=>{
            try {
                const v = document.createElement('video');
                v.muted = true; v.playsInline = true; v.preload = 'metadata';
                v.src = `/uploads/${encodeURIComponent(item.filename)}`;
                const onMeta = () => {
                    const dur = Math.max(0, v.duration||0);
                    const t = Math.min(1.0, dur * 0.1);
                    const onSeek = () => {
                        try {
                            const w = 120; // small thumb
                            const h = Math.max(1, Math.round((v.videoHeight||180) * (w / Math.max(1, v.videoWidth||320))));
                            const canvas = document.createElement('canvas');
                            canvas.width = w; canvas.height = h;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(v, 0, 0, w, h);
                            item.thumb = canvas.toDataURL('image/jpeg', 0.6);
                            resolve(item.thumb);
                            v.remove();
                        } catch { resolve(null); v.remove(); }
                    };
                    v.currentTime = t;
                    v.addEventListener('seeked', onSeek, {once:true});
                };
                v.addEventListener('loadedmetadata', onMeta, {once:true});
                v.addEventListener('error', ()=>{ resolve(null); v.remove(); }, {once:true});
            } catch { resolve(null); }
        });
    }

    // Render list rows: thumb (left) + progress (middle) + download (right) + delete X on thumb corner + plus card
        function renderList(){
        const items = batchState.items || [];
        if (!items.length){
            list.innerHTML = '<div class="small muted">No files added. Use the + to add videos.</div>';
            return;
        }
        const rows = items.map(it=>{
            const safeName = (it.display||it.filename||'').replace(/</g,'&lt;');
            const thumb = it.thumb ? `<img src="${it.thumb}" alt="${safeName}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;">` : `<div style="width:100%; height:100%; background:#ddd; border-radius:4px;"></div>`;
            const delBtn = `<button class="batch-del" data-file="${it.filename}" title="Remove" aria-label="Remove" style="position:absolute; top:2px; right:2px; width:18px; height:18px; line-height:16px; text-align:center; border:none; border-radius:50%; background:#dc3545; color:#fff; cursor:pointer;">×</button>`;
            const dlDisabled = it.output ? '' : 'disabled';
            const dlHref = it.output ? `/download?file=${encodeURIComponent(it.output)}` : '#';
            return `
                        <div class="batch-row" data-file="${it.filename}" style="display:flex; align-items:center; gap:10px; padding:6px 0;">
                            <div class="batch-thumb" style="position:relative; width:120px; height:68px; flex:0 0 120px; cursor:${batchState.presetMode==='custom'?'pointer':'default'};">${thumb}${delBtn}</div>
              <div class="batch-progress" style="flex:1;">
                <div style="width:100%; background:#eee; height:12px; border-radius:4px; overflow:hidden;">
                  <div class="bar" style="width:${it.percent||0}%; height:100%; background:#17a2b8;"></div>
                </div>
                <div class="small muted" style="margin-top:4px;">${safeName} — <span class="pct">${it.percent||0}%</span></div>
              </div>
              <div class="batch-actions" style="flex:0 0 auto;">
                <a class="btn-dl" href="${dlHref}" ${dlDisabled} style="padding:6px 10px; border:1px solid #28a745; border-radius:4px; color:#28a745; text-decoration:none; opacity:${it.output?1:0.5}; pointer-events:${it.output?'auto':'none'};">Download</a>
              </div>
            </div>`;
        }).join('');
                const plusCard = `
                <div style="margin-top:6px;">
                    <button id="batch-plus" type="button" title="Add more" aria-label="Add more" style="width:32px; height:32px; border-radius:50%; border:1px solid #0d6efd; color:#0d6efd; background:transparent; cursor:pointer; font-size:20px; line-height:28px;">+</button>
                </div>`;
        list.innerHTML = rows + plusCard;
        // Bind delete buttons
        list.querySelectorAll('button.batch-del').forEach(btn=>{
            btn.addEventListener('click', ()=>{
                const file = btn.getAttribute('data-file');
                if (!file || batchState.batchId) return; // disable deletion during running batch
                const idx = batchState.items.findIndex(it=>it.filename===file);
                if (idx>=0){ batchState.items.splice(idx,1); batchState.files = batchState.items.map(x=>x.filename); renderList(); }
            });
        });
        // Bind click on thumb to open in editor (custom mode)
        if (batchState.presetMode === 'custom'){
            list.querySelectorAll('.batch-row .batch-thumb').forEach(el=>{
                el.addEventListener('click', ()=>{
                    const row = el.closest('.batch-row');
                    const file = row ? row.getAttribute('data-file') : null;
                    const it = (batchState.items||[]).find(x=>x.filename===file);
                    if (it) loadBatchItemIntoEditor(it);
                });
            });
        }
        // Bind plus button
        const plus = document.getElementById('batch-plus');
        if (plus){ plus.addEventListener('click', ()=>{ input.click(); }); }
    }

    async function addUploadedFiles(fileList){
        // fileList: array of {filename, duration, display?}
    const added = (fileList||[]).map(f=>({ filename: f.filename, display: f.display||f.filename, duration: f.duration||0, size: f.size||0, thumb: null, percent: 0, output: null, cuts: [], selectionMode: 'cut', settings: null }));
        batchState.items = (batchState.items||[]).concat(added);
        batchState.files = batchState.items.map(x=>x.filename);
        renderList();
        // Generate thumbnails lazily
        for (const it of added){ try { await ensureBatchThumb(it); renderList(); } catch {} }
    }

    // Refactor upload logic for reuse by button and input change
    async function uploadSelectedFiles(){
        const filesSel = input.files;
        if (!filesSel || !filesSel.length){ alert('Select videos for batch'); return; }
        const fd = new FormData();
        for (const f of filesSel){ fd.append('videos', f); }
        btnUpload.disabled = true;
        btnUpload.textContent = 'Uploading…';
        try {
            const res = await fetch('/batch/upload', {method:'POST', body: fd});
            const js = await res.json();
            if (!res.ok){ throw new Error(js.error || 'Upload failed'); }
            await addUploadedFiles(js.files||[]);
        } catch (e){ alert(e.message); }
        finally { btnUpload.disabled = false; btnUpload.textContent = 'Upload Files'; input.value=''; }
    }

    btnUpload.addEventListener('click', uploadSelectedFiles);
    // Auto-upload when files are picked (for + button UX)
    input.addEventListener('change', uploadSelectedFiles);

    // Preset mode switch
    function applyPresetMode(){
        batchState.presetMode = presetModeSel.value === 'custom' ? 'custom' : 'single';
        helpText.textContent = (batchState.presetMode === 'custom')
            ? 'Custom mode: Click a thumbnail to open it above, set cuts and settings per video. Start will use each video\'s custom settings.'
            : 'Single preset: Batch uses the current cut ranges, codecs, resolution and compression settings you\'ve selected above.';
    // Start button removed; Start Processing is now universal
        // Hide editor sections when in Batch + Single preset; show them for Custom preset
        try {
            const procModeSel = document.getElementById('processing-mode');
            const inBatchMode = procModeSel && procModeSel.value === 'batch';
            const hideEditor = inBatchMode && batchState.presetMode === 'single';
            const ids = ['metrics-bar','video-wrap','controls-and-preview','timeline-wrap'];
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                if (hideEditor) {
                    el.dataset._prevDisplay = el.style.display || '';
                    el.style.display = 'none';
                } else {
                    // restore previous inline display if we hid it
                    if (el.dataset._prevDisplay !== undefined) {
                        el.style.display = el.dataset._prevDisplay;
                        delete el.dataset._prevDisplay;
                    } else {
                        el.style.display = '';
                    }
                }
            });
        } catch {}
        renderList();
    }
    presetModeSel.addEventListener('change', applyPresetMode);
    applyPresetMode();

    // Start button removed; starting is handled by the universal Start Processing button

    btnCancel.addEventListener('click', async ()=>{
        if (!batchState.batchId) return;
        try {
            await fetch(`/batch/cancel?batch_id=${encodeURIComponent(batchState.batchId)}`, {method:'POST'});
        } catch {}
        if (batchState.polling) { clearInterval(batchState.polling); batchState.polling=null; }
        btnCancel.style.display = 'none';
    });

    // ---- Custom per-video editing helpers ----
    function collectCurrentSettings(){
        return {
            mode: document.getElementById('mode')?.value || 'quality',
            quality_percent: parseInt(document.getElementById('quality_percent')?.value || '100',10),
            target_size_mb: parseFloat(document.getElementById('target_size_mb')?.value || '0') || undefined,
            crf: parseInt(document.getElementById('crf_value')?.value || '28',10),
            resolution: document.getElementById('resolution')?.value || 'original',
            width: (document.getElementById('custom_width')?.value||'').trim() || undefined,
            height: (document.getElementById('custom_height')?.value||'').trim() || undefined,
            video_codec: document.getElementById('video_codec')?.value || 'h264',
            audio_codec: document.getElementById('audio_codec')?.value || 'aac',
            container: document.getElementById('container')?.value || 'mp4',
            audio_preset: document.getElementById('audio_bitrate_preset')?.value === 'original' ? 'original' : undefined,
            audio_kbps: document.getElementById('audio_bitrate_preset')?.value !== 'original' ? parseInt(document.getElementById('audio_bitrate_preset')?.value || '128',10) : undefined,
        };
    }
    function applySettingsToUI(s){
        if (!s) return;
        const setVal = (id,val)=>{ const el = document.getElementById(id); if (el && val !== undefined && val !== null) { el.value = String(val); } };
        setVal('mode', s.mode);
        // Trigger mode visibility
        const modeSelEl = document.getElementById('mode');
        if (modeSelEl) { const evt = new Event('change'); modeSelEl.dispatchEvent(evt); }
        setVal('quality_percent', s.quality_percent);
        setVal('target_size_mb', s.target_size_mb);
        setVal('crf_value', s.crf);
        setVal('resolution', s.resolution);
        // Trigger res visibility
        const resSelEl = document.getElementById('resolution');
        if (resSelEl) { const evt = new Event('change'); resSelEl.dispatchEvent(evt); }
        setVal('custom_width', s.width);
        setVal('custom_height', s.height);
        setVal('video_codec', s.video_codec);
        setVal('audio_codec', s.audio_codec);
        setVal('container', s.container);
        const abEl = document.getElementById('audio_bitrate_preset');
        if (abEl) { abEl.value = (s.audio_preset === 'original') ? 'original' : String(s.audio_kbps || 'original'); }
        // Update dependent filters/estimates
        try {
            if (modeSelEl) modeSelEl.dispatchEvent(new Event('change'));
            if (resSelEl) resSelEl.dispatchEvent(new Event('change'));
            const vSel = document.getElementById('video_codec'); if (vSel) vSel.dispatchEvent(new Event('change'));
            const cSel = document.getElementById('container'); if (cSel) cSel.dispatchEvent(new Event('change'));
        } catch {}
        updateEstimatedSizeDisplay();
    }
    function persistEditsIntoCurrentBatchItem(){
        const file = batchState.currentFile;
        if (!file) return;
        const it = (batchState.items||[]).find(x=>x.filename===file);
        if (!it) return;
        it.settings = collectCurrentSettings();
        // capture cuts from slider
        if (slider && slider.noUiSlider){
            let values = slider.noUiSlider.get();
            if (!Array.isArray(values)) values = [values];
            if (values.length % 2 !== 0) values = values.slice(0, values.length-1);
            it.cuts = [];
            for (let i=0;i<values.length;i+=2){
                const s = parseFloat(values[i]); const e = parseFloat(values[i+1]);
                if (Number.isFinite(s) && Number.isFinite(e) && e>s) it.cuts.push([s,e]);
            }
        }
        it.selectionMode = selectionMode;
    }
    async function loadBatchItemIntoEditor(item){
        // persist current
        try { persistEditsIntoCurrentBatchItem(); } catch {}
        batchState.currentFile = item.filename;
        // load video
        const videoEl = document.getElementById('video');
        if (!videoEl) return;
        videoFilename = item.filename;
        // restore cuts and selection
        cuts = (item.cuts||[]).map(p=>({start:p[0], end:p[1]}));
        selectionMode = item.selectionMode || 'cut';
        const selModeEl = document.getElementById('selection-mode'); if (selModeEl) selModeEl.value = selectionMode;
        const applyAfter = ()=>{
            const newDur = Math.max(0, videoEl.duration||item.duration||0);
            videoDuration = newDur;
            updateSlider();
            updateFinalDurationDisplay();
            updateEstimatedSizeDisplay();
            // apply settings per item
            if (item.settings) applySettingsToUI(item.settings);
            // update original size display if provided from upload probe
            if (typeof item.size === 'number' && item.size > 0){
                try { origBytes = item.size; const el = document.getElementById('orig-size'); if (el) el.textContent = formatBytes(origBytes); } catch {}
            }
        };
        if (videoEl.src.includes(encodeURIComponent(item.filename)) && videoEl.readyState >= 1){
            applyAfter();
        } else {
            videoEl.src = `/uploads/${encodeURIComponent(item.filename)}`;
            videoEl.addEventListener('loadedmetadata', ()=>{ applyAfter(); }, {once:true});
            videoEl.load();
        }
    }
}

// Add Cut button behavior: first time adds a default cut (original behavior),
// subsequent times arm a single placement to click where you want
function addCutOrPlace(){
    // If no slider or no cuts yet, do original addCut()
    const hasCuts = Array.isArray(cuts) && cuts.length > 0;
    if (!slider || !slider.noUiSlider || !hasCuts) {
        addCut();
        return;
    }
    // Arm one-shot placement (not persistent) then auto-disarm after first placement
    const btn = document.getElementById('btn-add-cut');
    let placed = false;
    const disarmOneShot = () => {
        slider.style.outline = '';
        slider.removeEventListener('pointerdown', handler, true);
        slider.removeEventListener('mousedown', handler, true);
        slider.removeEventListener('click', swallow, true);
        slider.removeEventListener('contextmenu', cancel, true);
        if (btn) { btn.textContent = '➕ Add Cut Range'; btn.style.background = ''; btn.style.color = ''; }
    };
    const swallow = (e)=>{ if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); };
    const cancel = (e)=>{ swallow(e); disarmOneShot(); };
    const handler = (e)=>{
        const type = e.type;
        if (type === 'pointerdown' || type === 'mousedown'){
            if (e.button !== 0) { cancel(e); return; }
            swallow(e);
            const rect = slider.getBoundingClientRect();
            if (!rect || rect.width <= 0 || !Number.isFinite(videoDuration) || videoDuration <= 0) { disarmOneShot(); return; }
            const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            const t = (x / rect.width) * videoDuration;
            addCutAt(t);
            placed = true;
            disarmOneShot();
            return;
        }
    };
    slider.style.outline = '2px dashed #0d6efd';
    if (btn) { btn.textContent = 'Click on timeline…'; btn.style.background = '#0d6efd'; btn.style.color = '#fff'; }
    slider.addEventListener('pointerdown', handler, true);
    slider.addEventListener('mousedown', handler, true);
    slider.addEventListener('click', swallow, true);
    slider.addEventListener('contextmenu', cancel, true);
}


// ---------------- Clips Add + Per-clip Trim + Merge ----------------
const clipsState = {
    items: [], // {id, filename, duration, size, display, cuts: [[s,e],...], selectionMode: 'cut'|'keep'}
    currentId: null
};

function setupClipsUI(){
    const btnAdd = document.getElementById('btn-add-video');
    const input = document.getElementById('clips-add-input');
    const panel = document.getElementById('clips-panel');
    const list = document.getElementById('clips-list');
    if (!btnAdd || !input || !panel || !list) return;

    // Ensure the currently loaded single video is captured as a clip (once)
    let seededCurrent = false;
    const ensureCurrentClipAdded = (withEdits=false) => {
        try {
            if (!videoFilename) return;
            if (clipsState.items.some(it => it.filename === videoFilename)) return;
            const name = String(videoFilename||'').split(/[\\/]/).pop();
            const clip = {
                id: crypto.randomUUID(),
                filename: videoFilename,
                duration: Math.max(0, Number(videoDuration)||0),
                size: origBytes||0,
                display: name||videoFilename,
                cuts: [],
                selectionMode: selectionMode||'cut'
            };
            if (withEdits) {
                try {
                    if (Array.isArray(cuts) && cuts.length){
                        clip.cuts = cuts.map(c => [Number(c.start)||0, Number(c.end)||0]);
                    }
                } catch {}
            }
            clipsState.items.unshift(clip);
            seededCurrent = true;
        } catch {}
    };

    const render = () => {
    const count = clipsState.items.length;
    // Show panel only when there are at least two videos to merge
    panel.style.display = (count >= 2) ? 'block' : 'none';
        // Grid of thumbnails
        const cards = clipsState.items.map((it)=>{
            const label = (it.display || it.filename || '').replace(/</g,'&lt;');
            const totalDur = Math.max(0, Number(it.duration)||0);
            const keptDur = computeKeptForClip(it);
            const durTxt = formatHMS(Math.round(totalDur));
            const keptTxt = keptDur > 0 ? formatHMS(Math.round(keptDur)) : '00:00';
            const cutsCount = (it.cuts||[]).length;
            const meta = `${durTxt} total • ${keptTxt} kept${cutsCount?` • ${cutsCount} cut${cutsCount>1?'s':''}`:''}`;
            const current = (clipsState.currentId === it.id) ? ' clip-current' : '';
            const thumbSrc = it.thumb || '';
            const thumbEl = thumbSrc ? `<img class=\"clip-thumb\" src=\"${thumbSrc}\" alt=\"${label}\">` : `<div class=\"clip-thumb clip-thumb-placeholder\"></div>`;
            return `<div class=\"clip-card${current}\" draggable=\"true\" data-id=\"${it.id}\" title=\"Click to edit; drag to reorder\">\
                <div class=\"clip-thumb-wrap\">${thumbEl}<button class=\"clip-delete\" data-action=\"delete\" data-id=\"${it.id}\" title=\"Remove clip\" aria-label=\"Remove clip\">×</button></div>\
                <div class=\"clip-name\">${label}</div>\
                <div class=\"clip-meta small muted\">${meta}</div>\
            </div>`;
        }).join('');
        list.innerHTML = `<div class="clips-grid">${cards}</div>`;
        // Lazy-generate missing thumbnails
        clipsState.items.forEach(c=>{ if (!c.thumb) { try { ensureClipThumb(c).then(()=>{ render(); }); } catch {} } });
    };

    btnAdd.addEventListener('click', ()=> { ensureCurrentClipAdded(true); render(); input.click(); });
    input.addEventListener('change', async ()=>{
        const files = input.files;
        if (!files || !files.length) return;
        const fd = new FormData();
        for (const f of files) fd.append('videos', f);
        btnAdd.disabled = true; btnAdd.textContent = 'Adding…';
        try {
            const res = await fetch('/clips/upload', {method:'POST', body: fd});
            const js = await res.json();
            if (!res.ok) throw new Error(js.error||'Upload failed');
            // Make sure current clip is present so it isn't lost
            ensureCurrentClipAdded(true);
            const added = (js.files||[]).map(f=>({
                id: crypto.randomUUID(), filename: f.filename, duration: f.duration||0, size: f.size||0, display: f.display||f.filename, cuts: [], selectionMode: 'cut'
            }));
            clipsState.items.push(...added);
            render();
        } catch(e){ alert(e.message); }
        finally { btnAdd.disabled=false; btnAdd.textContent='Add Video'; input.value=''; }
    });

    // Seed current video on first render if user already uploaded one
    if (!seededCurrent) { ensureCurrentClipAdded(true); }
    render();

    // Click-to-edit on card; also handle delete button
    list.addEventListener('click', (e)=>{
        if (clipsState._dragging) return; // ignore click during drag
        // Handle delete clicks
        const delBtn = e.target.closest('button.clip-delete');
        if (delBtn) {
            const id = delBtn.getAttribute('data-id');
            const idx = clipsState.items.findIndex(it=>it.id===id);
            if (idx >= 0) {
                // Persist current edits before changing selection
                try { persistEditsIntoCurrentClip(); } catch {}
                const priorCount = clipsState.items.length;
                const deletingCurrent = (clipsState.currentId === id);
                clipsState.items.splice(idx,1);
                if (clipsState.items.length > 0) {
                    if (priorCount === 2) {
                        // Exactly two before; load the sole remaining clip
                        const remaining = clipsState.items[0];
                        clipsState.currentId = remaining.id;
                        loadClipIntoEditor(remaining);
                    } else if (deletingCurrent) {
                        // Pick neighbor at same index or previous if at end
                        const selIdx = Math.min(idx, clipsState.items.length - 1);
                        const nextClip = clipsState.items[selIdx];
                        if (nextClip) {
                            clipsState.currentId = nextClip.id;
                            loadClipIntoEditor(nextClip);
                        } else {
                            render();
                        }
                    } else {
                        // Deleted a non-current item; just re-render
                        render();
                    }
                } else {
                    // No clips left
                    clipsState.currentId = null;
                    render();
                }
            }
            e.stopPropagation();
            return;
        }
        const card = e.target.closest('.clip-card');
        if (!card) return;
        const id = card.getAttribute('data-id');
        const clip = clipsState.items.find(it=>it.id===id);
        if (clip) loadClipIntoEditor(clip);
    });

    // Drag-and-drop reordering
    let dragId = null;
    list.addEventListener('dragstart', (e)=>{
        const card = e.target.closest('.clip-card');
        if (!card) return;
        dragId = card.getAttribute('data-id');
        clipsState._dragging = true;
        try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch {}
        card.classList.add('dragging');
    });
    list.addEventListener('dragend', (e)=>{
        const card = e.target.closest('.clip-card');
        if (card) card.classList.remove('dragging');
        clipsState._dragging = false;
        dragId = null;
    });
    list.addEventListener('dragover', (e)=>{
        const over = e.target.closest('.clip-card');
        if (!over) return;
        e.preventDefault();
        over.classList.add('drag-over');
    });
    list.addEventListener('dragleave', (e)=>{
        const over = e.target.closest('.clip-card');
        if (over) over.classList.remove('drag-over');
    });
    list.addEventListener('drop', (e)=>{
        const over = e.target.closest('.clip-card');
        if (!over) return;
        e.preventDefault();
        over.classList.remove('drag-over');
        const overId = over.getAttribute('data-id');
        const fromIdx = clipsState.items.findIndex(it=>it.id===dragId);
        const toIdx = clipsState.items.findIndex(it=>it.id===overId);
        if (fromIdx<0 || toIdx<0 || fromIdx===toIdx) return;
        const [it] = clipsState.items.splice(fromIdx,1);
        clipsState.items.splice(toIdx,0,it);
        render();
    });

    // Removed Clear and Start buttons; processing will use the default Start Processing button.

    const persistEditsIntoCurrentClip = () => {
        if (!clipsState.currentId) return;
        const clip = clipsState.items.find(x=>x.id===clipsState.currentId);
        if (!clip) return;
        console.log(`[persistEditsIntoCurrentClip] Persisting edits for clip ${clip.display}`);
        // Read current cuts/selectionMode from editor
        if (slider && slider.noUiSlider){
            let values = slider.noUiSlider.get();
            if (!Array.isArray(values)) values = [values];
            if (values.length % 2 !== 0) values = values.slice(0, values.length-1);
            clip.cuts = [];
            for (let i=0;i<values.length;i+=2){
                const s = parseFloat(values[i]); const e = parseFloat(values[i+1]);
                if (Number.isFinite(s) && Number.isFinite(e) && e>s) clip.cuts.push([s,e]);
            }
        }
        clip.selectionMode = selectionMode;
        console.log(`[persistEditsIntoCurrentClip] Saved cuts:`, clip.cuts, `selectionMode: ${clip.selectionMode}`);
    };

    async function loadClipIntoEditor(clip){
        // Persist any current edits before switching
        persistEditsIntoCurrentClip();
        
        console.log(`[loadClipIntoEditor] Loading clip ${clip.display} with cuts:`, clip.cuts);
        clipsState.currentId = clip.id;
        
        try {
            const videoEl = document.getElementById('video');
            if (!videoEl) return;
            
            // Update current video filename for single processing option
            videoFilename = clip.filename;
            
            // Reset timeline to clip's saved cuts BEFORE loading video
            cuts = (clip.cuts||[]).map(p=>({start:p[0], end:p[1]}));
            selectionMode = clip.selectionMode||'cut';
            const selModeEl = document.getElementById('selection-mode');
            if (selModeEl) selModeEl.value = selectionMode;
            
            console.log(`[loadClipIntoEditor] Reset cuts to:`, cuts);
            
            // Function to update slider after video is ready
            const updateAfterLoad = () => {
                const newDuration = Math.max(0, videoEl.duration||0);
                console.log(`[updateAfterLoad] Setting videoDuration from ${videoDuration} to ${newDuration}`);
                videoDuration = newDuration;
                console.log(`[updateAfterLoad] Video duration: ${videoDuration}, restoring cuts:`, clip.cuts);
                // Restore the cuts for this clip
                cuts = (clip.cuts||[]).map(p=>({start:p[0], end:p[1]}));
                console.log(`[updateAfterLoad] Before updateSlider, cuts:`, cuts);
                updateSlider();
                console.log(`[updateAfterLoad] After updateSlider, cuts:`, cuts);
                updateFinalDurationDisplay();
                updateEstimatedSizeDisplay();
                // Re-highlight selected clip
                const list = document.getElementById('clips-list');
                if (list) {
                    const cards = list.querySelectorAll('.clip-card');
                    cards.forEach(c=>{
                        const id = c.getAttribute('data-id');
                        if (id === clipsState.currentId) c.classList.add('clip-current'); else c.classList.remove('clip-current');
                    });
                }
            };
            
            // Check if video is already loaded (same source)
            if (videoEl.src.includes(encodeURIComponent(clip.filename)) && videoEl.readyState >= 1) {
                // Video already loaded, update immediately
                console.log('[loadClipIntoEditor] Video already loaded, updating immediately');
                updateAfterLoad();
            } else {
                // Load new video
                console.log('[loadClipIntoEditor] Loading new video source');
                videoEl.src = `/uploads/${encodeURIComponent(clip.filename)}`;
                // Use both loadedmetadata and loadeddata to handle different scenarios
                const onLoad = () => {
                    console.log('[loadClipIntoEditor] Video metadata loaded');
                    updateAfterLoad();
                };
                videoEl.addEventListener('loadedmetadata', onLoad, {once:true});
                videoEl.load();
            }
            
            render();
        } catch(e){ alert('Failed to load clip: '+e.message); }
    }

    async function ensureClipThumb(clip){
        if (!clip || clip.thumb) return clip.thumb;
        return new Promise((resolve) => {
            try {
                const v = document.createElement('video');
                v.muted = true; v.playsInline = true; v.preload = 'metadata';
                v.src = `/uploads/${encodeURIComponent(clip.filename)}`;
                const onMeta = () => {
                    const dur = Math.max(0, v.duration||0);
                    const t = Math.min(1.0, dur * 0.1);
                    const onSeek = () => {
                        try {
                            const w = 320;
                            const h = Math.max(1, Math.round((v.videoHeight||180) * (w / Math.max(1, v.videoWidth||320))));
                            const canvas = document.createElement('canvas');
                            canvas.width = w; canvas.height = h;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(v, 0, 0, w, h);
                            clip.thumb = canvas.toDataURL('image/jpeg', 0.6);
                            resolve(clip.thumb);
                            v.remove();
                        } catch { resolve(null); v.remove(); }
                    };
                    v.currentTime = t;
                    v.addEventListener('seeked', onSeek, {once:true});
                };
                v.addEventListener('loadedmetadata', onMeta, {once:true});
                v.addEventListener('error', ()=>{ resolve(null); v.remove(); }, {once:true});
            } catch { resolve(null); }
        });
    }

    function computeKeptForClip(clip){
        const dur = Math.max(0, Number(clip.duration)||0);
        const cuts = Array.isArray(clip.cuts) ? clip.cuts.map(p=>({start:Math.max(0, Math.min(dur, Number(p[0])||0)), end:Math.max(0, Math.min(dur, Number(p[1])||0))})).filter(c=>c.end>c.start+0.01).sort((a,b)=>a.start-b.start) : [];
        if (!cuts.length) {
            if ((clip.selectionMode||'cut') === 'keep') return 0; // keeping nothing if no ranges in keep mode
            return dur; // in cut mode with no cuts, keep all
        }
        if ((clip.selectionMode||'cut') === 'keep') {
            // Merge overlaps and sum kept ranges
            let merged = [];
            for (const c of cuts){
                if (!merged.length || c.start > merged[merged.length-1].end) merged.push({start:c.start,end:c.end});
                else merged[merged.length-1].end = Math.max(merged[merged.length-1].end, c.end);
            }
            return merged.reduce((acc,c)=> acc + Math.max(0, c.end - c.start), 0);
        } else {
            // Cut mode: kept = total minus cut durations (after merging overlaps)
            let merged = [];
            for (const c of cuts){
                if (!merged.length || c.start > merged[merged.length-1].end) merged.push({start:c.start,end:c.end});
                else merged[merged.length-1].end = Math.max(merged[merged.length-1].end, c.end);
            }
            const removed = merged.reduce((acc,c)=> acc + Math.max(0, c.end - c.start), 0);
            return Math.max(0, dur - removed);
        }
    }
}

// Start a batch process using current batchState and UI selections.
async function startBatchProcessFromUI(){
    const list = document.getElementById('batch-files-list');
    const jobsWrap = document.getElementById('batch-jobs');
    const overall = document.getElementById('batch-overall');
    const overallBar = document.getElementById('batch-overall-bar');
    const concurrencySel = document.getElementById('batch-concurrency');
    const btnCancel = document.getElementById('btn-batch-cancel');
    if (!list || !jobsWrap || !overall || !overallBar || !concurrencySel || !btnCancel) { alert('Batch panel is not ready.'); return; }
    if (!batchState.files || !batchState.files.length) { alert('Please upload videos to the Batch panel first.'); return; }

    // Persist edits into current batch item
    try {
        const file = batchState.currentFile;
        if (file){
            const it = (batchState.items||[]).find(x=>x.filename===file);
            if (it){
                it.settings = {
                    mode: document.getElementById('mode')?.value || 'quality',
                    quality_percent: parseInt(document.getElementById('quality_percent')?.value || '100',10),
                    target_size_mb: parseFloat(document.getElementById('target_size_mb')?.value || '0') || undefined,
                    crf: parseInt(document.getElementById('crf_value')?.value || '28',10),
                    resolution: document.getElementById('resolution')?.value || 'original',
                    width: (document.getElementById('custom_width')?.value||'').trim() || undefined,
                    height: (document.getElementById('custom_height')?.value||'').trim() || undefined,
                    video_codec: document.getElementById('video_codec')?.value || 'h264',
                    audio_codec: document.getElementById('audio_codec')?.value || 'aac',
                    container: document.getElementById('container')?.value || 'mp4',
                    audio_preset: document.getElementById('audio_bitrate_preset')?.value === 'original' ? 'original' : undefined,
                    audio_kbps: document.getElementById('audio_bitrate_preset')?.value !== 'original' ? parseInt(document.getElementById('audio_bitrate_preset')?.value || '128',10) : undefined,
                };
                if (slider && slider.noUiSlider){
                    let values = slider.noUiSlider.get();
                    if (!Array.isArray(values)) values = [values];
                    if (values.length % 2 !== 0) values = values.slice(0, values.length-1);
                    it.cuts = [];
                    for (let i=0;i<values.length;i+=2){
                        const s = parseFloat(values[i]); const e = parseFloat(values[i+1]);
                        if (Number.isFinite(s) && Number.isFinite(e) && e>s) it.cuts.push([s,e]);
                    }
                }
                it.selectionMode = selectionMode;
            }
        }
    } catch {}

    // Build payload
    let payload;
    if (batchState.presetMode === 'custom'){
        const per = (batchState.items||[]).map(it=>({
            file: it.filename,
            mode: it.settings?.mode || document.getElementById('mode')?.value || 'quality',
            quality_percent: it.settings?.quality_percent ?? parseInt(document.getElementById('quality_percent')?.value || '100',10),
            target_size_mb: it.settings?.target_size_mb ?? (parseFloat(document.getElementById('target_size_mb')?.value || '0') || undefined),
            crf: it.settings?.crf ?? parseInt(document.getElementById('crf_value')?.value || '28',10),
            resolution: it.settings?.resolution || document.getElementById('resolution')?.value || 'original',
            width: it.settings?.width ?? (((document.getElementById('custom_width')?.value||'').trim()) || undefined),
            height: it.settings?.height ?? (((document.getElementById('custom_height')?.value||'').trim()) || undefined),
            video_codec: it.settings?.video_codec || document.getElementById('video_codec')?.value || 'h264',
            audio_codec: it.settings?.audio_codec || document.getElementById('audio_codec')?.value || 'aac',
            container: it.settings?.container || document.getElementById('container')?.value || 'mp4',
            audio_preset: it.settings?.audio_preset ?? (document.getElementById('audio_bitrate_preset')?.value === 'original' ? 'original' : undefined),
            audio_kbps: it.settings?.audio_kbps ?? (document.getElementById('audio_bitrate_preset')?.value !== 'original' ? parseInt(document.getElementById('audio_bitrate_preset')?.value || '128',10) : undefined),
            cuts: (Array.isArray(it.cuts) && it.cuts.length) ? it.cuts : [],
            selection_mode: it.selectionMode || 'cut'
        }));
        payload = { files: batchState.files, per_file: per, concurrency: concurrencySel.value || 'auto' };
    } else {
        payload = {
            files: batchState.files,
            mode: document.getElementById('mode')?.value || 'quality',
            quality_percent: parseInt(document.getElementById('quality_percent')?.value || '100',10),
            target_size_mb: parseFloat(document.getElementById('target_size_mb')?.value || '0') || undefined,
            crf: parseInt(document.getElementById('crf_value')?.value || '28',10),
            resolution: document.getElementById('resolution')?.value || 'original',
            width: (document.getElementById('custom_width')?.value||'').trim() || undefined,
            height: (document.getElementById('custom_height')?.value||'').trim() || undefined,
            video_codec: document.getElementById('video_codec')?.value || 'h264',
            audio_codec: document.getElementById('audio_codec')?.value || 'aac',
            container: document.getElementById('container')?.value || 'mp4',
            audio_preset: document.getElementById('audio_bitrate_preset')?.value === 'original' ? 'original' : undefined,
            audio_kbps: document.getElementById('audio_bitrate_preset')?.value !== 'original' ? parseInt(document.getElementById('audio_bitrate_preset')?.value || '128',10) : undefined,
            cuts: cuts.map(c=>[c.start, c.end]),
            selection_mode: selectionMode,
            concurrency: concurrencySel.value || 'auto'
        };
    }

    isProcessing = true;
    btnCancel.style.display = 'inline-block';
    try {
        const res = await fetch('/batch/start', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
        const js = await res.json();
        if (!res.ok){ throw new Error(js.error || 'Start failed'); }
        batchState.batchId = js.batch_id;
        jobsWrap.innerHTML = js.jobs.map(j=>`<div data-job="${j}" style="margin:4px 0; display:none;"></div>`).join('');
        overall.style.display = 'block';
        if (batchState.polling) clearInterval(batchState.polling);
        batchState.polling = setInterval(async ()=>{
            try {
                const r = await fetch(`/batch/status?batch_id=${encodeURIComponent(batchState.batchId)}`);
                const st = await r.json();
                if (!r.ok) throw new Error(st.error||'Status error');
                overallBar.style.width = `${st.percent||0}%`;
                (st.jobs||[]).forEach(j=>{
                    const file = j.file;
                    if (!file) return;
                    const row = list.querySelector(`.batch-row[data-file="${CSS.escape(file)}"]`);
                    if (!row) return;
                    const bar = row.querySelector('.bar');
                    const pctEl = row.querySelector('.pct');
                    if (bar) bar.style.width = `${j.percent||0}%`;
                    if (pctEl) pctEl.textContent = `${j.percent||0}%`;
                    if (j.done && j.output){
                        const dl = row.querySelector('a.btn-dl');
                        if (dl){
                            dl.href = `/download?file=${encodeURIComponent(j.output)}`;
                            dl.removeAttribute('disabled');
                            dl.style.opacity = 1;
                            dl.style.pointerEvents = 'auto';
                        }
                        const it = (batchState.items||[]).find(it=>it.filename===file);
                        if (it){ it.output = j.output; it.percent = 100; }
                    } else {
                        const it = (batchState.items||[]).find(it=>it.filename===file);
                        if (it){ it.percent = j.percent||0; }
                    }
                });
                if (st.completed){
                    clearInterval(batchState.polling);
                    batchState.polling = null;
                    btnCancel.style.display = 'none';
                    isProcessing = false;
                }
            } catch {}
        }, 1000);
    } catch(e){ alert(e.message); isProcessing=false; btnCancel.style.display='none'; }
}