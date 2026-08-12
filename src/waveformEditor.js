import { computePeaks, drawWaveform } from './waveform.js';

const MIN_SEGMENT_SEC = 0.05;
const ZOOM_PADDING_SEC = 0.6;
const CREATE_DRAG_MIN_SEC = 0.15;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function makeMapper(overlayEl, viewStart, viewEnd) {
  const span = Math.max(0.001, viewEnd - viewStart);
  return {
    viewStart,
    viewEnd,
    timeToX: (t) => ((t - viewStart) / span) * overlayEl.clientWidth,
    xToTime: (x) => viewStart + (x / Math.max(1, overlayEl.clientWidth)) * span,
  };
}

/**
 * Interactive waveform strip for marking/adjusting "falas" (speech
 * segments): a full-clip overview (drag empty space to mark a new segment,
 * drag a region's edges or body to adjust it) plus a zoomed detail strip for
 * whichever row is focused, for frame-accurate trimming. Playhead follows
 * `video`'s currentTime so the player can see where they are while scrubbing.
 *
 * `rows` is the same mutable array the caller's number-input list edits —
 * both views stay in sync because they share the same row objects.
 */
export function mountWaveformEditor({
  overviewEl,
  zoomWrapEl,
  zoomLabelEl,
  zoomEl,
  samples,
  sampleRate,
  duration,
  rows,
  video,
  onRowsChanged,
  onCreateSegment,
}) {
  const overviewCanvas = overviewEl.querySelector('canvas');
  const overviewOverlay = overviewEl.querySelector('.waveform-overlay');
  const playhead = overviewEl.querySelector('.waveform-playhead');
  const zoomCanvas = zoomEl?.querySelector('canvas');
  const zoomOverlay = zoomEl?.querySelector('.waveform-overlay');

  const hasAudio = !!samples && duration > 0;
  let focusedId = null;
  let destroyed = false;
  // Frozen at the last renderZoom() call — reused (not recomputed) while a
  // drag is in progress so the zoom window doesn't recenter under the
  // player's cursor and make the untouched edge look like it's moving too.
  let currentZoomMapper = null;

  function findRow(id) {
    return rows.find((r) => r.id === id) || null;
  }

  function redrawOverviewWave() {
    if (!hasAudio) return;
    const bucketCount = Math.max(80, Math.floor(overviewCanvas.clientWidth || 400));
    drawWaveform(overviewCanvas, computePeaks(samples, sampleRate, 0, duration, bucketCount), {});
  }

  function redrawZoomWave(viewStart, viewEnd) {
    if (!hasAudio || !zoomCanvas) return;
    const bucketCount = Math.max(80, Math.floor(zoomCanvas.clientWidth || 400));
    drawWaveform(zoomCanvas, computePeaks(samples, sampleRate, viewStart, viewEnd, bucketCount), {
      color: 'rgba(255, 210, 61, 0.9)',
    });
  }

  function renderRegion(row, mapper, overlayEl2) {
    const region = el(
      `<div class="waveform-region" data-row-id="${row.id}">
        <div class="waveform-handle waveform-handle-left"></div>
        <div class="waveform-handle waveform-handle-right"></div>
      </div>`
    );
    positionRegion(region, row, mapper);
    if (row.id === focusedId) region.classList.add('waveform-region-focused');
    wireRegion(region, row, mapper, overlayEl2);
    return region;
  }

  function positionRegion(regionEl, row, mapper) {
    const x1 = mapper.timeToX(row.start);
    const x2 = mapper.timeToX(row.end);
    regionEl.style.left = `${x1}px`;
    regionEl.style.width = `${Math.max(2, x2 - x1)}px`;
  }

  function wireRegion(regionEl, row, mapper, overlayEl2) {
    const leftHandle = regionEl.querySelector('.waveform-handle-left');
    const rightHandle = regionEl.querySelector('.waveform-handle-right');

    function wireHandle(handleEl, edge) {
      handleEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        setFocused(row.id);
        handleEl.setPointerCapture(e.pointerId);
        const rect = overlayEl2.getBoundingClientRect();

        const onMove = (ev) => {
          const t = clamp(mapper.xToTime(ev.clientX - rect.left), 0, duration);
          if (edge === 'left') row.start = Math.min(t, row.end - MIN_SEGMENT_SEC);
          else row.end = Math.max(t, row.start + MIN_SEGMENT_SEC);
          positionRegion(regionEl, row, mapper);
          syncSiblingViews(row);
        };
        const onUp = () => {
          handleEl.removeEventListener('pointermove', onMove);
          handleEl.removeEventListener('pointerup', onUp);
          onRowsChanged?.();
        };
        handleEl.addEventListener('pointermove', onMove);
        handleEl.addEventListener('pointerup', onUp);
      });
    }
    wireHandle(leftHandle, 'left');
    wireHandle(rightHandle, 'right');

    // Dragging the region body moves both bounds together.
    regionEl.addEventListener('pointerdown', (e) => {
      if (e.target !== regionEl) return;
      setFocused(row.id);
      regionEl.setPointerCapture(e.pointerId);
      const rect = overlayEl2.getBoundingClientRect();
      const pxPerSec = rect.width / (mapper.viewEnd - mapper.viewStart);
      const startClientX = e.clientX;
      const origStart = row.start;
      const origEnd = row.end;
      const segSpan = origEnd - origStart;

      const onMove = (ev) => {
        const dt = (ev.clientX - startClientX) / pxPerSec;
        let newStart = clamp(origStart + dt, 0, duration - segSpan);
        row.start = newStart;
        row.end = newStart + segSpan;
        positionRegion(regionEl, row, mapper);
        syncSiblingViews(row);
      };
      const onUp = () => {
        regionEl.removeEventListener('pointermove', onMove);
        regionEl.removeEventListener('pointerup', onUp);
        onRowsChanged?.();
      };
      regionEl.addEventListener('pointermove', onMove);
      regionEl.addEventListener('pointerup', onUp);
    });
  }

  // While dragging in one view (e.g. the overview), keep the other view
  // (the zoom strip, or vice versa) visually in sync without a full re-render.
  // The overview's mapper is always [0, duration] so it's safe to recompute;
  // the zoom's mapper is NOT recomputed here (see `currentZoomMapper`).
  function syncSiblingViews(row) {
    const overviewMapper = makeMapper(overviewOverlay, 0, duration);
    overviewOverlay.querySelectorAll(`.waveform-region[data-row-id="${row.id}"]`).forEach((r) => {
      positionRegion(r, row, overviewMapper);
    });
    if (zoomOverlay && focusedId === row.id && currentZoomMapper) {
      zoomOverlay.querySelectorAll(`.waveform-region[data-row-id="${row.id}"]`).forEach((r) => {
        positionRegion(r, row, currentZoomMapper);
      });
    }
  }

  function currentZoomRange() {
    const row = findRow(focusedId);
    if (!row) return [0, duration];
    return [Math.max(0, row.start - ZOOM_PADDING_SEC), Math.min(duration, row.end + ZOOM_PADDING_SEC)];
  }

  function renderOverviewRegions() {
    overviewOverlay.querySelectorAll('.waveform-region').forEach((r) => r.remove());
    const mapper = makeMapper(overviewOverlay, 0, duration);
    rows.forEach((row, index) => {
      const region = renderRegion(row, mapper, overviewOverlay);
      const label = document.createElement('span');
      label.className = 'waveform-region-label';
      label.textContent = `#${index + 1}`;
      region.appendChild(label);
      overviewOverlay.appendChild(region);
    });
  }

  function renderZoom() {
    if (!zoomWrapEl) return;
    const row = findRow(focusedId);
    if (!row || !hasAudio) {
      zoomWrapEl.hidden = true;
      currentZoomMapper = null;
      return;
    }
    zoomWrapEl.hidden = false;
    const [viewStart, viewEnd] = currentZoomRange();
    if (zoomLabelEl) {
      zoomLabelEl.textContent = `Zoom — fala #${rows.indexOf(row) + 1} (${row.character || ''})`;
    }
    redrawZoomWave(viewStart, viewEnd);
    zoomOverlay.querySelectorAll('.waveform-region').forEach((r) => r.remove());
    const mapper = makeMapper(zoomOverlay, viewStart, viewEnd);
    currentZoomMapper = mapper;
    zoomOverlay.appendChild(renderRegion(row, mapper, zoomOverlay));
  }

  function setFocused(rowId) {
    if (focusedId === rowId) return;
    focusedId = rowId;
    overviewOverlay.querySelectorAll('.waveform-region').forEach((r) => {
      r.classList.toggle('waveform-region-focused', r.dataset.rowId === rowId);
    });
    renderZoom();
  }

  // Click-drag on empty overview space marks a brand-new segment.
  overviewOverlay.addEventListener('pointerdown', (e) => {
    if (e.target !== overviewOverlay || !hasAudio) return;
    const rect = overviewOverlay.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const ghost = el('<div class="waveform-region waveform-region-ghost"></div>');
    overviewOverlay.appendChild(ghost);
    overviewOverlay.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const curX = clamp(ev.clientX - rect.left, 0, rect.width);
      const left = Math.min(startX, curX);
      const width = Math.abs(curX - startX);
      ghost.style.left = `${left}px`;
      ghost.style.width = `${width}px`;
    };
    const onUp = (ev) => {
      overviewOverlay.removeEventListener('pointermove', onMove);
      overviewOverlay.removeEventListener('pointerup', onUp);
      ghost.remove();
      const mapper = makeMapper(overviewOverlay, 0, duration);
      const curX = clamp(ev.clientX - rect.left, 0, rect.width);
      const t1 = mapper.xToTime(Math.min(startX, curX));
      const t2 = mapper.xToTime(Math.max(startX, curX));
      if (t2 - t1 >= CREATE_DRAG_MIN_SEC) onCreateSegment?.(t1, t2);
    };
    overviewOverlay.addEventListener('pointermove', onMove);
    overviewOverlay.addEventListener('pointerup', onUp);
  });

  function onVideoTimeUpdate() {
    if (!video.duration) return;
    playhead.style.left = `${(video.currentTime / duration) * overviewOverlay.clientWidth}px`;
  }
  video?.addEventListener('timeupdate', onVideoTimeUpdate);

  function refresh() {
    if (destroyed) return;
    redrawOverviewWave();
    renderOverviewRegions();
    renderZoom();
  }

  function destroy() {
    destroyed = true;
    video?.removeEventListener('timeupdate', onVideoTimeUpdate);
  }

  if (!hasAudio) {
    overviewEl.classList.add('waveform-strip-empty');
  }
  refresh();
  window.addEventListener('resize', refresh);

  return {
    refresh,
    setFocused,
    destroy: () => {
      window.removeEventListener('resize', refresh);
      destroy();
    },
  };
}
