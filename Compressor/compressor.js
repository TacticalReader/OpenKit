(function () {
    'use strict';

    const MAX_FILES = 10;
    const MAX_SIZE_BYTES = 10 * 1024 * 1024;
    const MAX_DIMENSION = 4096;
    const PROXY_MAX_DIM = 640;
    const ESTIMATE_CONCURRENCY = 3;
    const SLIDER_DEBOUNCE_MS = 220;
    const MODE_DEBOUNCE_MS = 100;
    const ACCEPT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif',
        'image/gif', 'image/bmp'];

    const MODE_QUALITY = {
        'balanced': 0.80,
        'max-savings': 0.50,
        'max-quality': 0.95,
    };

    let images = [];
    let currentMode = 'balanced';
    let currentQ = 0.80;
    let estimateGeneration = 0;
    let estimateDebounceTimer = null;

    function getEl(id) {
        const el = document.getElementById(id);
        if (!el) throw new Error(`[Compressor] Required DOM element #${id} not found. Check your HTML.`);
        return el;
    }

    const dropzone = getEl('dropzone');
    const fileInput = getEl('fileInput');
    const listSection = getEl('listSection');
    const imageTableBody = getEl('imageTableBody');
    const imageCountHead = getEl('imageCountHeading');
    const clearAllBtn = getEl('clearAllBtn');
    const compressBtn = getEl('compressBtn');
    const downloadAllBtn = getEl('downloadAllBtn');
    const qualitySlider = getEl('qualitySlider');
    const qualityDisplay = getEl('qualityDisplay');
    const modeCards = document.querySelectorAll('.mode-card');
    const sumOriginal = getEl('sumOriginal');
    const sumEstimated = getEl('sumEstimated');
    const sumSavings = getEl('sumSavings');

    const howItWorksBtn = getEl('howItWorksBtn');
    const hiwBackdrop = getEl('hiwBackdrop');
    const hiwClose = getEl('hiwClose');
    const hiwGotIt = getEl('hiwGotIt');

    function openHiw() {
        hiwBackdrop.removeAttribute('hidden');
        document.body.style.overflow = 'hidden';
        hiwClose.focus();
    }
    function closeHiw() {
        hiwBackdrop.setAttribute('hidden', '');
        document.body.style.overflow = '';
        howItWorksBtn.focus();
    }

    howItWorksBtn.addEventListener('click', openHiw);
    hiwClose.addEventListener('click', closeHiw);
    hiwGotIt.addEventListener('click', closeHiw);

    hiwBackdrop.addEventListener('click', e => {
        if (e.target === hiwBackdrop) closeHiw();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !hiwBackdrop.hasAttribute('hidden')) closeHiw();
    });

    qualitySlider.addEventListener('input', () => {
        const val = parseInt(qualitySlider.value, 10);
        currentQ = val / 100;
        qualityDisplay.textContent = val + '%';
        updateSliderTrack();

        let matched = false;
        modeCards.forEach(c => {
            const presetVal = Math.round((MODE_QUALITY[c.dataset.mode] ?? NaN) * 100);
            if (presetVal === val) {
                c.classList.add('active');
                currentMode = c.dataset.mode;
                matched = true;
            } else {
                c.classList.remove('active');
            }
        });
        void matched;

        scheduleEstimate(SLIDER_DEBOUNCE_MS);
    });

    function updateSliderTrack() {
        const val = parseFloat(qualitySlider.value);
        const min = parseFloat(qualitySlider.min) || 1;
        const max = parseFloat(qualitySlider.max) || 100;
        const pct = ((val - min) / (max - min)) * 100;
        qualitySlider.style.background =
            `linear-gradient(to right, var(--indigo-500) ${pct}%, var(--border) ${pct}%)`;
    }
    updateSliderTrack();

    function positionSliderLabels() {
        const labelsWrap = document.querySelector('.slider-labels');
        if (!labelsWrap) return;
        const labels = labelsWrap.querySelectorAll('span[data-value]');
        const min = parseFloat(qualitySlider.min) || 1;
        const max = parseFloat(qualitySlider.max) || 100;
        labels.forEach(lbl => {
            const v = parseFloat(lbl.dataset.value);
            const pct = ((v - min) / (max - min)) * 100;
            lbl.style.left = `${pct}%`;
        });
    }
    positionSliderLabels();

    modeCards.forEach(card => {
        card.addEventListener('click', () => {
            modeCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            currentMode = card.dataset.mode;

            const preset = Math.round(MODE_QUALITY[currentMode] * 100);
            qualitySlider.value = preset;
            currentQ = MODE_QUALITY[currentMode];
            qualityDisplay.textContent = preset + '%';
            updateSliderTrack();

            scheduleEstimate(MODE_DEBOUNCE_MS);
        });
    });

    dropzone.addEventListener('dragover', e => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', e => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        addFiles(Array.from(e.dataTransfer.files));
    });
    dropzone.addEventListener('click', e => {
        if (e.target.tagName !== 'LABEL') {
            fileInput.click();
        }
    });
    dropzone.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });
    fileInput.addEventListener('change', () => {
        addFiles(Array.from(fileInput.files));
        fileInput.value = '';
    });

    function addFiles(files) {
        const remaining = MAX_FILES - images.length;
        if (remaining <= 0) {
            showToast(`Maximum ${MAX_FILES} images allowed.`, 'error');
            return;
        }

        let added = 0;
        let skipped = 0;

        const toProcess = files.slice(0, remaining);

        toProcess.forEach(file => {
            if (!ACCEPT_TYPES.includes(file.type)) {
                skipped++;
                return;
            }
            if (file.size > MAX_SIZE_BYTES) {
                showToast(`"${file.name}" exceeds 10 MB limit and was skipped.`, 'error');
                skipped++;
                return;
            }
            const isDupe = images.some(img =>
                img.file.name === file.name &&
                img.file.size === file.size &&
                img.file.lastModified === file.lastModified
            );
            if (isDupe) {
                skipped++;
                return;
            }

            const entry = {
                id: generateId(),
                file: file,
                objectURL: URL.createObjectURL(file),
                width: 0,
                height: 0,
                originalSize: file.size,
                estimatedSize: 0,
                estimating: true,
                proxyCanvas: null,
                proxyScaleFactor: 1,
                status: 'ready',
                compressedBlob: null,
                compressedURL: null,
            };

            images.push(entry);
            added++;

            loadImageMeta(entry).then(() => {
                renderTable();
                scheduleEstimate(0);
            });
        });

        if (added > 0 || images.length > 0) {
            renderTable();
            updateSummary();
            listSection.removeAttribute('hidden');
        }

        if (skipped > 0 && added === 0) {
            showToast('Some files were invalid or already added.', 'info');
        }
        if (files.length > remaining) {
            showToast(`Only ${remaining} more image(s) can be added (max ${MAX_FILES}).`, 'info');
        }
    }

    function loadImageMeta(entry) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                entry.width = img.naturalWidth;
                entry.height = img.naturalHeight;
                buildProxyCanvas(entry, img);
                resolve();
            };
            img.onerror = () => {
                console.warn(`Could not load image "${entry.file.name}" for preview or estimation.`);
                entry.estimating = false;
                entry.estimatedSize = entry.originalSize;
                resolve();
            };
            img.src = entry.objectURL;
        });
    }

    function buildProxyCanvas(entry, img) {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return;

        const longest = Math.max(w, h);
        const scale = longest > PROXY_MAX_DIM ? PROXY_MAX_DIM / longest : 1;
        const pw = Math.max(1, Math.round(w * scale));
        const ph = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = pw;
        canvas.height = ph;
        const ctx = canvas.getContext('2d');

        const mimeOut = resolveOutputMime(entry.file.type);
        if (mimeOut === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, pw, ph);
        }
        ctx.drawImage(img, 0, 0, pw, ph);

        entry.proxyCanvas = canvas;
        entry.proxyScaleFactor = (w * h) / (pw * ph);
    }

    function resolveOutputMime(inputType) {
        switch (inputType) {
            case 'image/png': return 'image/png';
            case 'image/jpeg': return 'image/jpeg';
            case 'image/webp': return 'image/webp';
            default: return 'image/webp';
        }
    }

    function estimateEntrySize(entry, quality) {
        return new Promise(resolve => {
            if (!entry.proxyCanvas) { resolve(entry.originalSize); return; }
            const mimeOut = resolveOutputMime(entry.file.type);
            entry.proxyCanvas.toBlob(blob => {
                if (!blob) { resolve(entry.originalSize); return; }
                const scaled = Math.round(blob.size * entry.proxyScaleFactor);
                resolve(Math.max(scaled, 512));
            }, mimeOut, mimeOut === 'image/png' ? undefined : quality);
        });
    }

    function scheduleEstimate(delay) {
        if (estimateDebounceTimer) clearTimeout(estimateDebounceTimer);
        estimateDebounceTimer = setTimeout(() => {
            estimateGeneration++;
            runEstimatePass(estimateGeneration);
        }, delay);
    }

    function runEstimatePass(generation) {
        const targets = images.filter(e =>
            e.status !== 'done' && e.status !== 'compressing' && e.proxyCanvas
        );
        if (targets.length === 0) return;

        const quality = currentQ;
        let cursor = 0;

        async function worker() {
            while (cursor < targets.length) {
                if (generation !== estimateGeneration) return;
                const entry = targets[cursor++];
                entry.estimating = true;
                renderTable();

                const size = await estimateEntrySize(entry, quality);

                if (generation !== estimateGeneration) return;
                entry.estimating = false;
                entry.estimatedSize = size;
                renderTable();
                updateSummary();
            }
        }

        const workerCount = Math.min(ESTIMATE_CONCURRENCY, targets.length);
        for (let i = 0; i < workerCount; i++) worker();
    }

    function renderTable() {
        imageCountHead.textContent = `Added Images (${images.length})`;

        if (images.length === 0) {
            listSection.setAttribute('hidden', '');
            return;
        }

        imageTableBody.innerHTML = '';

        images.forEach(entry => {
            const isDone = entry.status === 'done' && entry.compressedBlob;
            const hasEstimate = isDone || entry.estimatedSize > 0;
            const displaySize = isDone ? entry.compressedBlob.size : entry.estimatedSize;
            const savingBytes = entry.originalSize - displaySize;
            const savingPct = entry.originalSize > 0
                ? Math.round((savingBytes / entry.originalSize) * 100)
                : 0;

            const tr = document.createElement('tr');

            const tdPrev = document.createElement('td');
            tdPrev.className = 'col-preview';
            const img = document.createElement('img');
            img.src = entry.objectURL;
            img.className = 'img-thumb';
            img.alt = entry.file.name;
            img.loading = 'lazy';
            tdPrev.appendChild(img);
            tr.appendChild(tdPrev);

            const tdName = document.createElement('td');
            tdName.className = 'col-name';
            const nameWrap = document.createElement('div');
            nameWrap.className = 'file-name-cell';
            const nameStrong = document.createElement('strong');
            nameStrong.textContent = entry.file.name;
            const nameSub = document.createElement('span');
            const typeName = entry.file.type.replace('image/', '').toUpperCase();
            nameSub.textContent = `${typeName}${entry.width ? ' • ' + entry.width + ' × ' + entry.height : ''}`;
            nameWrap.appendChild(nameStrong);
            nameWrap.appendChild(nameSub);
            tdName.appendChild(nameWrap);
            tr.appendChild(tdName);

            const tdOrig = document.createElement('td');
            tdOrig.className = 'col-orig';
            tdOrig.textContent = formatSize(entry.originalSize);
            tr.appendChild(tdOrig);

            const tdEst = document.createElement('td');
            tdEst.className = 'col-est';
            if (!hasEstimate) {
                tdEst.textContent = 'Estimating…';
            } else if (entry.estimating && !isDone) {
                tdEst.textContent = `${formatSize(displaySize)} …`;
            } else {
                tdEst.textContent = formatSize(displaySize);
            }
            tr.appendChild(tdEst);

            const tdSave = document.createElement('td');
            tdSave.className = 'col-save';
            const savingSpan = document.createElement('span');
            savingSpan.className = 'savings-badge';
            if (!hasEstimate) {
                savingSpan.textContent = '—';
                savingSpan.style.opacity = '0.55';
            } else if (savingPct < 0) {
                savingSpan.textContent = `+${formatSize(-savingBytes)} (larger)`;
                savingSpan.style.opacity = '0.55';
            } else {
                savingSpan.textContent = `${formatSize(savingBytes)} (${savingPct}%)`;
            }
            tdSave.appendChild(savingSpan);
            tr.appendChild(tdSave);

            const tdStatus = document.createElement('td');
            tdStatus.className = 'col-status';
            const statusCell = document.createElement('div');
            statusCell.className = 'status-cell';
            const dot = document.createElement('span');
            dot.className = `status-dot ${entry.status}`;
            const label = document.createElement('span');
            label.className = `status-label ${entry.status}`;
            label.textContent = capitalise(entry.status);
            statusCell.appendChild(dot);
            statusCell.appendChild(label);
            tdStatus.appendChild(statusCell);
            tr.appendChild(tdStatus);

            const tdAct = document.createElement('td');
            tdAct.className = 'col-actions';
            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'actions-cell';

            if (entry.status === 'done' && entry.compressedURL) {
                const dlBtn = document.createElement('button');
                dlBtn.className = 'dl-row-btn';
                dlBtn.title = 'Download compressed image';
                dlBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
                dlBtn.addEventListener('click', () => downloadSingle(entry));
                actionsWrap.appendChild(dlBtn);
            }

            const delBtn = document.createElement('button');
            delBtn.className = 'del-btn';
            delBtn.title = 'Remove image';
            delBtn.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
            delBtn.addEventListener('click', () => removeEntry(entry.id));
            actionsWrap.appendChild(delBtn);

            tdAct.appendChild(actionsWrap);
            tr.appendChild(tdAct);

            imageTableBody.appendChild(tr);
        });

        const anyDone = images.some(img => img.status === 'done');
        const anyReady = images.some(img => img.status === 'ready' || img.status === 'error');
        compressBtn.disabled = images.length === 0 || !anyReady;
        downloadAllBtn.disabled = !anyDone;
    }

    function updateSummary() {
        if (images.length === 0) { return; }

        const allDone = images.every(e => e.status === 'done');

        const totalOrig = images.reduce((acc, e) => acc + e.originalSize, 0);
        const totalEst = images.reduce((acc, e) => {
            if (e.status === 'done' && e.compressedBlob) return acc + e.compressedBlob.size;
            return acc + e.estimatedSize;
        }, 0);
        const savings = totalOrig - totalEst;
        const savingsPct = totalOrig > 0 ? Math.round((savings / totalOrig) * 100) : 0;

        sumOriginal.textContent = formatSize(totalOrig);
        sumEstimated.textContent = formatSize(totalEst);
        sumSavings.textContent = `${formatSize(savings)} (${savingsPct}%)`;

        const estLabel = sumEstimated.previousElementSibling;
        if (estLabel) {
            estLabel.textContent = allDone ? 'Actual Total Size' : 'Estimated Total Size';
        }
    }

    function removeEntry(id) {
        const idx = images.findIndex(e => e.id === id);
        if (idx === -1) return;
        const entry = images[idx];
        URL.revokeObjectURL(entry.objectURL);
        if (entry.compressedURL) URL.revokeObjectURL(entry.compressedURL);
        images.splice(idx, 1);
        renderTable();
        updateSummary();
        if (images.length === 0) {
            listSection.setAttribute('hidden', '');
        }
    }

    clearAllBtn.addEventListener('click', () => {
        images.forEach(e => {
            URL.revokeObjectURL(e.objectURL);
            if (e.compressedURL) URL.revokeObjectURL(e.compressedURL);
        });
        images = [];
        renderTable();
        listSection.setAttribute('hidden', '');
    });

    compressBtn.addEventListener('click', compressAll);

    async function compressAll() {
        const toCompress = images.filter(e => e.status === 'ready' || e.status === 'error');
        if (toCompress.length === 0) return;

        if (estimateDebounceTimer) clearTimeout(estimateDebounceTimer);
        estimateGeneration++;

        compressBtn.disabled = true;
        compressBtn.classList.add('compressing');
        compressBtn.innerHTML = '<i class="fa-solid fa-spinner"></i> Compressing…';

        let hadError = false;

        for (const entry of toCompress) {
            entry.status = 'compressing';
            renderTable();
            try {
                await compressOne(entry);
                entry.status = 'done';
            } catch (err) {
                console.error('Compression failed for', entry.file.name, err);
                entry.status = 'error';
                hadError = true;
                showToast(`Could not compress "${entry.file.name}". ${err.message || ''}`, 'error');
            }
            renderTable();
            updateSummary();
        }

        compressBtn.classList.remove('compressing');
        compressBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Compress Images';

        renderTable();

        if (!hadError) showToast('Compression complete!', 'success');
    }

    function compressOne(entry) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                let outW = img.naturalWidth;
                let outH = img.naturalHeight;

                if (outW > MAX_DIMENSION || outH > MAX_DIMENSION) {
                    const scale = Math.min(MAX_DIMENSION / outW, MAX_DIMENSION / outH);
                    outW = Math.round(outW * scale);
                    outH = Math.round(outH * scale);
                }

                const canvas = document.createElement('canvas');
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext('2d');

                const mimeOut = resolveOutputMime(entry.file.type);

                if (mimeOut === 'image/jpeg') {
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }

                ctx.drawImage(img, 0, 0, outW, outH);

                const q = currentQ;

                canvas.toBlob(blob => {
                    if (!blob) { reject(new Error('toBlob returned null')); return; }
                    entry.compressedBlob = blob;
                    if (entry.compressedURL) URL.revokeObjectURL(entry.compressedURL);
                    entry.compressedURL = URL.createObjectURL(blob);
                    resolve();
                }, mimeOut, mimeOut === 'image/png' ? undefined : q);
            };
            img.onerror = () => reject(new Error('Image could not be loaded for compression.'));
            img.src = entry.objectURL;
        });
    }

    function downloadSingle(entry) {
        if (!entry.compressedURL) return;
        const a = document.createElement('a');
        a.href = entry.compressedURL;
        const outMime = entry.compressedBlob ? entry.compressedBlob.type : null;
        a.download = compressedFilename(entry.file.name, outMime);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    downloadAllBtn.addEventListener('click', async () => {
        const done = images.filter(e => e.status === 'done' && e.compressedURL);
        if (done.length === 0) return;

        if (done.length === 1) {
            downloadSingle(done[0]);
            return;
        }

        downloadAllBtn.disabled = true;
        for (const entry of done) {
            downloadSingle(entry);
            await sleep(200);
        }
        downloadAllBtn.disabled = false;
        showToast(`${done.length} images downloaded!`, 'success');
    });

    function compressedFilename(original, mimeOut) {
        const extMap = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/webp': '.webp',
        };
        const lastDot = original.lastIndexOf('.');
        const base = lastDot > 0 ? original.slice(0, lastDot) : original;
        const newExt = extMap[mimeOut] || (lastDot > 0 ? original.slice(lastDot) : '');
        return `${base}-compressed${newExt}`;
    }

    function formatSize(bytes) {
        if (bytes === 0) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function capitalise(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function generateId() {
        return '_' + Math.random().toString(36).slice(2, 11);
    }

    function sleep(ms) {
        return new Promise(res => setTimeout(res, ms));
    }

    let toastTimer = null;

    function showToast(message, type = 'info') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        if (toastTimer) clearTimeout(toastTimer);

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = {
            success: 'fa-solid fa-circle-check',
            error: 'fa-solid fa-circle-xmark',
            info: 'fa-solid fa-circle-info',
        }[type] || 'fa-solid fa-circle-info';

        toast.innerHTML = `<i class="${icon}"></i> ${message}`;
        document.body.appendChild(toast);

        toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(8px)';
            toast.style.transition = 'opacity .25s ease, transform .25s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3200);
    }

})();

