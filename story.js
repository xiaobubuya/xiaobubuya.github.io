let storyBgActiveLayer = 'A';
let storyScrollRaf = null;
let storyListenersController = null;

const storyLoopState = {
    baseStart: 0,
    segmentWidth: 0,
    total: 0,
    activeOrder: 0,
    touchStartX: 0,
    touchStartY: 0
};

function getStoryTitle(order) {
    const titles = ['心动开场', '日常发光', '双向奔赴', '城市漫游', '未来序章', '星光尾注'];
    return titles[(order - 1) % titles.length];
}

function getStoryText(photo) {
    if (!photo || !photo.name) return '故事还在继续，下一幕由今天的我们书写。';
    const shortName = photo.name.split('/').pop().replace(/^\d+_/, '').replace(/\.[^/.]+$/, '');
    return `我们把「${shortName || '这一刻'}」收藏进回忆里，平凡日子也因此有了闪光。`;
}

function updateStoryStageByIndex(photoIndex, chapterTitle = '') {
    const imgEl = document.getElementById('storyStageImg');
    const titleEl = document.getElementById('storyStageTitle');
    const textEl = document.getElementById('storyStageText');
    if (!imgEl || !titleEl || !textEl) return;

    const photo = photos[photoIndex];
    if (!photo) {
        imgEl.classList.remove('active');
        imgEl.removeAttribute('src');
        titleEl.textContent = '我们的现在';
        textEl.textContent = '横向滑动胶片，故事镜头会在这里同步切换。';
        return;
    }

    imgEl.classList.remove('active');
    imgEl.src = getImageUrl(photo.name);
    imgEl.onload = () => imgEl.classList.add('active');
    titleEl.textContent = chapterTitle || '故事章节';
    textEl.textContent = getStoryText(photo);
}

function syncStoryBackdrop(photoIndex) {
    const layerA = document.getElementById('storyBgLayerA');
    const layerB = document.getElementById('storyBgLayerB');
    if (!layerA || !layerB) return;

    const photo = photos[photoIndex];
    if (!photo) {
        layerA.classList.remove('active');
        layerB.classList.remove('active');
        return;
    }

    const nextLayer = storyBgActiveLayer === 'A' ? layerB : layerA;
    const prevLayer = storyBgActiveLayer === 'A' ? layerA : layerB;
    nextLayer.style.backgroundImage = `url('${getImageUrl(photo.name)}')`;
    prevLayer.classList.remove('active');
    nextLayer.classList.add('active');
    storyBgActiveLayer = storyBgActiveLayer === 'A' ? 'B' : 'A';
}

function getStoryTrack() {
    return document.getElementById('storyFilmTrack');
}

function getStoryViewport() {
    return document.getElementById('storyFilmViewport');
}

function getMiddleStoryItem(order) {
    return document.querySelector(`.timeline-item[data-segment="real"][data-order="${order}"]`);
}

function updateTimelineProgressByOrder(order, total) {
    const progress = document.getElementById('timelineProgress');
    const text = document.getElementById('storyProgressText');
    if (!progress || !text) return;

    const safeTotal = Math.max(total, 1);
    const percent = safeTotal <= 1 ? 100 : (order / (safeTotal - 1)) * 100;
    progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    text.textContent = `第 ${order + 1} 幕 / 共 ${safeTotal} 幕`;
}

function activateStoryOrder(order) {
    if (storyLoopState.total <= 0) return;
    const safeOrder = ((order % storyLoopState.total) + storyLoopState.total) % storyLoopState.total;

    document.querySelectorAll('.timeline-item').forEach(el => {
        const isActive = parseInt(el.dataset.order, 10) === safeOrder;
        el.classList.toggle('active', isActive);
    });

    storyLoopState.activeOrder = safeOrder;
    updateTimelineProgressByOrder(safeOrder, storyLoopState.total);

    const card = getMiddleStoryItem(safeOrder)?.querySelector('.timeline-card[data-photo-index]');
    if (!card) {
        updateStoryStageByIndex(-1);
        syncStoryBackdrop(-1);
        return;
    }

    const index = parseInt(card.dataset.photoIndex, 10);
    const title = card.querySelector('h4')?.textContent || '';
    if (!isNaN(index)) {
        updateStoryStageByIndex(index, title);
        syncStoryBackdrop(index);
    }
}

function keepStoryInLoopRange() {
    const viewport = getStoryViewport();
    if (!viewport || storyLoopState.segmentWidth <= 0) return;

    const leftBoundary = storyLoopState.baseStart - storyLoopState.segmentWidth / 2;
    const rightBoundary = storyLoopState.baseStart + storyLoopState.segmentWidth / 2;

    if (viewport.scrollLeft < leftBoundary) {
        viewport.scrollLeft += storyLoopState.segmentWidth;
    } else if (viewport.scrollLeft > rightBoundary) {
        viewport.scrollLeft -= storyLoopState.segmentWidth;
    }
}

function detectActiveStoryByCenter() {
    const viewport = getStoryViewport();
    if (!viewport) return;

    const viewportRect = viewport.getBoundingClientRect();
    const center = viewportRect.left + viewportRect.width / 2;

    const candidates = Array.from(document.querySelectorAll('.timeline-item'));
    if (!candidates.length) return;

    let closestOrder = parseInt(candidates[0].dataset.order, 10) || 0;
    let minDistance = Infinity;

    candidates.forEach(item => {
        const rect = item.getBoundingClientRect();
        const itemCenter = rect.left + rect.width / 2;
        const distance = Math.abs(itemCenter - center);
        if (distance < minDistance) {
            minDistance = distance;
            closestOrder = parseInt(item.dataset.order, 10) || 0;
        }
    });

    activateStoryOrder(closestOrder);
}

function syncStoryByScroll() {
    storyScrollRaf = null;
    keepStoryInLoopRange();
    detectActiveStoryByCenter();
}

function onStoryScroll() {
    if (storyScrollRaf) return;
    storyScrollRaf = requestAnimationFrame(syncStoryByScroll);
}

function scrollToStoryOrder(order, behavior = 'smooth') {
    const viewport = getStoryViewport();
    const target = getMiddleStoryItem(order);
    if (!viewport || !target) return;

    viewport.scrollTo({
        left: target.offsetLeft,
        behavior
    });
    activateStoryOrder(order);
}

function stepStory(delta) {
    if (storyLoopState.total <= 0) return;
    const nextOrder = (storyLoopState.activeOrder + delta + storyLoopState.total) % storyLoopState.total;
    scrollToStoryOrder(nextOrder);
}

function storyPrev() {
    stepStory(-1);
}

function storyNext() {
    stepStory(1);
}

function bindStoryInteractions() {
    const viewport = getStoryViewport();
    if (!viewport) return;

    if (storyListenersController) {
        storyListenersController.abort();
    }
    storyListenersController = new AbortController();
    const signal = storyListenersController.signal;

    viewport.addEventListener('scroll', onStoryScroll, { passive: true, signal });

    viewport.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            viewport.scrollLeft += e.deltaY;
            e.preventDefault();
        }
    }, { passive: false, signal });

    viewport.addEventListener('touchstart', (e) => {
        const t = e.changedTouches?.[0];
        if (!t) return;
        storyLoopState.touchStartX = t.clientX;
        storyLoopState.touchStartY = t.clientY;
    }, { passive: true, signal });

    viewport.addEventListener('touchend', (e) => {
        const t = e.changedTouches?.[0];
        if (!t) return;

        const dx = t.clientX - storyLoopState.touchStartX;
        const dy = t.clientY - storyLoopState.touchStartY;
        if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return;
        if (dx < 0) {
            storyNext();
        } else {
            storyPrev();
        }
    }, { passive: true, signal });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') storyPrev();
        if (e.key === 'ArrowRight') storyNext();
    }, { signal });
}

function buildFilmItem(node, order, segment) {
    const cardClass = `timeline-card ${node.isNow ? 'now-card' : ''}`;
    const dataAttr = typeof node.photoIndex === 'number' && node.photoIndex >= 0
        ? `data-photo-index="${node.photoIndex}"`
        : '';

    return `
        <article class="timeline-item" data-order="${order}" data-segment="${segment}">
            <span class="timeline-date">${node.dateLabel}</span>
            <div class="${cardClass}" ${dataAttr}>
                <h4>${node.title}</h4>
                <p>${node.text}</p>
            </div>
        </article>
    `;
}

function buildStoryFilmNodes(force = false) {
    const timelinePhotos = [...photos]
        .filter(p => typeof p.timestamp === 'number' && !isNaN(p.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);

    if (!timelinePhotos.length) return [];

    const maxNodes = 8;
    const total = timelinePhotos.length;
    const nodeCount = Math.min(maxNodes, total);
    const sampled = [];

    for (let i = 0; i < nodeCount; i++) {
        let index;
        if (force && total > 3) {
            index = Math.floor(Math.random() * total);
        } else {
            index = total === 1 ? 0 : Math.round((i * (total - 1)) / (nodeCount - 1 || 1));
        }
        sampled.push(timelinePhotos[index]);
    }

    const uniqueNodes = sampled.filter((item, idx, arr) => arr.findIndex(t => t.name === item.name) === idx);
    const filmNodes = uniqueNodes.map((photo, idx) => ({
        order: idx,
        photoIndex: photos.findIndex(p => p.name === photo.name),
        dateLabel: new Date(photo.timestamp).toLocaleDateString('zh-CN'),
        title: `第${idx + 1}幕 · ${getStoryTitle(idx + 1)}`,
        text: getStoryText(photo),
        isNow: idx === uniqueNodes.length - 1
    }));

    filmNodes.push({
        order: filmNodes.length,
        photoIndex: -1,
        dateLabel: 'NOW',
        title: '正在上映 · 我们的现在',
        text: '故事仍在更新，下一张照片会成为新的片段。',
        isNow: true
    });

    return filmNodes;
}

function setupStoryLoopMetrics() {
    const viewport = getStoryViewport();
    const firstReal = document.querySelector('.timeline-item[data-segment="real"][data-order="0"]');
    const firstNext = document.querySelector('.timeline-item[data-segment="next"][data-order="0"]');

    if (!viewport || !firstReal || !firstNext) return;

    storyLoopState.baseStart = firstReal.offsetLeft;
    storyLoopState.segmentWidth = firstNext.offsetLeft - firstReal.offsetLeft;

    viewport.scrollLeft = storyLoopState.baseStart;
}

function renderStoryTimeline(force = false) {
    const container = document.getElementById('storyTimeline');
    if (!container) return;

    const filmNodes = buildStoryFilmNodes(force);
    storyLoopState.total = filmNodes.length;
    storyLoopState.activeOrder = 0;

    if (!filmNodes.length) {
        container.innerHTML = `
            <div class="story-film-shell empty">
                <div class="story-empty">上传几张照片后，这里会自动生成横向胶片叙事。</div>
            </div>
        `;
        updateStoryStageByIndex(-1);
        syncStoryBackdrop(-1);
        return;
    }

    const cardsHtml = [
        ...filmNodes.map((node, idx) => buildFilmItem(node, idx, 'prev')),
        ...filmNodes.map((node, idx) => buildFilmItem(node, idx, 'real')),
        ...filmNodes.map((node, idx) => buildFilmItem(node, idx, 'next'))
    ].join('');

    container.innerHTML = `
        <div class="story-film-shell">
            <div id="storyFilmViewport" class="story-film-viewport">
                <div id="storyFilmTrack" class="story-film-track">${cardsHtml}</div>
            </div>
        </div>
        <div class="film-footer">
            <div class="film-progress-track">
                <div id="timelineProgress" class="film-progress-fill"></div>
            </div>
            <div class="film-meta">
                <span id="storyProgressText">第 1 幕 / 共 ${filmNodes.length} 幕</span>
                <span>手动滑动浏览</span>
            </div>
        </div>
    `;

    setupStoryLoopMetrics();
    bindStoryInteractions();
    activateStoryOrder(0);
}

window.renderStoryTimeline = renderStoryTimeline;
window.storyPrev = storyPrev;
window.storyNext = storyNext;
