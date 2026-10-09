/* ============================================================
   Side-Step GUI — Chart Interaction (shared)
   TensorBoard-faithful interactions:
   - drag box → animated zoom (TB: 750ms cubic-in-out)
   - Alt/Shift+drag: pan
   - Alt+wheel: cursor-centered zoom
   - double-click: reset zoom
   ============================================================ */

const ChartInteraction = (() => {
  "use strict";

  // TB easing: cubic-in-out (d3.easeCubicInOut equivalent)
  function _easeCubicInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * TB-faithful closest-index finder (matches findClosestIndex in
   * line_chart_interactive_utils.ts using d3.bisect on sorted x-values).
   * Returns the index of the data point closest to targetX.
   */
  function _findClosestIndex(sortedXs, targetX) {
    if (sortedXs.length === 0) return 0;
    // Binary search (equivalent to d3.bisect)
    let lo = 0, hi = sortedXs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedXs[mid] < targetX) lo = mid + 1;
      else hi = mid;
    }
    const right = Math.min(lo, sortedXs.length - 1);
    const left = Math.max(0, right - 1);
    return Math.abs(sortedXs[left] - targetX) <= Math.abs(sortedXs[right] - targetX) ? left : right;
  }

  /**
   * Wire interactive chart controls on a chart area.
   * @param {object} opts
   * @param {string} opts.areaId   - chart-area container element ID
   * @param {string} opts.svgId    - SVG element ID inside the area
   * @param {function} opts.getView      - () => { startIdx, endIdx, totalLen }
   * @param {function} opts.setRange     - (lo, hi) => void
   * @param {function} opts.zoomReset    - () => void
   * @param {function} [opts.formatTip]  - (dataIdx, frac) => HTML string
   * @param {function} [opts.onHover]    - (dataIdx) => void — called on hover with data index
   * @param {function} [opts.onLeave]    - () => void — called when mouse leaves chart
   * @param {number}   [opts.minRange]   - minimum zoom window in samples
   * @param {number}   [opts.zoomStep]   - wheel zoom step (fraction, default 0.16)
   * @param {boolean}  [opts.enableDoubleClickReset] - reset zoom on dblclick
   */
  function wire(opts) {
    const area = document.getElementById(opts.areaId);
    const svg = document.getElementById(opts.svgId);
    if (!area || !svg) return;

    // Always ensure area is a positioning context for overlays
    area.style.position = "relative";

    // Reuse existing overlay/crosshair/tooltip or create new ones
    const _find = (cls) => area.querySelector("." + cls) || area.querySelector("[id*='" + cls.replace("chart-","") + "']");
    let overlay = _find("chart-drag-overlay") || _find("chart-zoom-box");
    if (!overlay) { overlay = document.createElement("div"); overlay.className = "chart-zoom-box"; overlay.style.cssText = "display:none;position:absolute;pointer-events:none;z-index:2;"; area.appendChild(overlay); }
    let crosshair = _find("chart-crosshair");
    if (!crosshair) { crosshair = document.createElement("div"); crosshair.className = "chart-crosshair"; crosshair.style.cssText = "display:none;position:absolute;top:0;bottom:0;width:1px;background:var(--muted);opacity:0.5;pointer-events:none;z-index:3;"; area.appendChild(crosshair); }
    let tooltip = _find("chart-tooltip");
    if (!tooltip) { tooltip = document.createElement("div"); tooltip.className = "chart-tooltip--tb"; tooltip.style.cssText = "display:none;"; area.appendChild(tooltip); }

    // Crosshair cursor by default
    area.style.cursor = 'crosshair';

    // Zoom hint badge — shown on non-Alt scroll (TB-style)
    const zoomHint = area.querySelector('.chart-zoom-hint');
    let _hintTimer = null;
    function _showZoomHint() {
      if (!zoomHint) return;
      zoomHint.classList.add('visible');
      clearTimeout(_hintTimer);
      _hintTimer = setTimeout(() => zoomHint.classList.remove('visible'), 3000);
    }

    // Alt or Shift key → grab cursor for pan mode hint
    const _onKeyDown = (e) => { if ((e.key === 'Shift' || e.key === 'Alt') && !panning) area.style.cursor = 'grab'; };
    const _onKeyUp = (e) => { if ((e.key === 'Shift' || e.key === 'Alt') && !panning) area.style.cursor = 'crosshair'; };
    document.addEventListener('keydown', _onKeyDown);
    document.addEventListener('keyup', _onKeyUp);

    const minRange = Math.max(2, Number(opts.minRange) || 2);
    const SCROLL_ZOOM_SPEED_FACTOR = 0.01; // TB constant from line_chart_interactive_view.ts
    const allowDoubleClickReset = opts.enableDoubleClickReset !== false;
    const ZOOM_ANIM_MS = 400; // TB uses 750ms, we use 400ms for snappier feel

    let dragStart = null, panning = false, panView = null;
    let _interacting = false; // true during drag/pan — suppresses tooltip
    let _animating = false;

    function pxToFrac(clientX) {
      const r = svg.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
    }

    // TB: both Alt and Shift trigger pan
    function isPanGesture(e) {
      return !!e.altKey || !!e.shiftKey;
    }

    function clampRange(lo, hi, totalLen) {
      const total = Math.max(1, Number(totalLen) || 1);
      const minAllowed = Math.max(1, Math.min(minRange, total));
      let start = Math.max(0, Number(lo) || 0);
      let end = Math.min(total, Number(hi) || total);
      if (end - start < minAllowed) {
        const mid = (start + end) / 2;
        start = Math.max(0, mid - minAllowed / 2);
        end = Math.min(total, start + minAllowed);
        start = Math.max(0, end - minAllowed);
      }
      return { lo: start, hi: end };
    }

    // Animated zoom transition (TB: d3.easeCubicInOut over 750ms)
    function _animateZoom(fromLo, fromHi, toLo, toHi, totalLen) {
      _animating = true;
      const start = performance.now();
      function tick(now) {
        const elapsed = now - start;
        const t = Math.min(1, elapsed / ZOOM_ANIM_MS);
        const e = _easeCubicInOut(t);
        const lo = fromLo + (toLo - fromLo) * e;
        const hi = fromHi + (toHi - fromHi) * e;
        const clamped = clampRange(lo, hi, totalLen);
        opts.setRange(clamped.lo, clamped.hi);
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          _animating = false;
        }
      }
      requestAnimationFrame(tick);
    }

    function _hideTooltip() {
      tooltip.style.display = "none";
      crosshair.style.display = "none";
      if (opts.onLeave) opts.onLeave();
    }

    area.addEventListener("mousedown", (e) => {
      // TB: left or middle button; middle always pans
      const isLeft = e.button === 0;
      const isMiddle = e.button === 1;
      if (!isLeft && !isMiddle) return;
      if (isMiddle || (isLeft && isPanGesture(e))) {
        panning = true;
        _interacting = true;
        panView = opts.getView();
        area.style.cursor = 'grabbing';
        _hideTooltip();
        e.preventDefault();
        return;
      }
      const r = area.getBoundingClientRect();
      dragStart = { x: e.clientX, left: e.clientX - r.left };
      _interacting = true;
      overlay.style.display = "none";
      _hideTooltip();
      e.preventDefault();
    });

    const _onDocMouseMove = (e) => {
      if (panning && panView) {
        // TB uses event.movementX for smooth incremental pan
        const r = svg.getBoundingClientRect();
        const deltaX = -e.movementX;
        const dataRange = panView.endIdx - panView.startIdx;
        const shift = (deltaX / (r.width || 1)) * dataRange;
        let lo = panView.startIdx + shift, hi = panView.endIdx + shift;
        if (lo < 0) { hi -= lo; lo = 0; }
        if (hi > panView.totalLen) { lo -= (hi - panView.totalLen); hi = panView.totalLen; lo = Math.max(0, lo); }
        const clamped = clampRange(lo, hi, panView.totalLen);
        opts.setRange(clamped.lo, clamped.hi);
        // Update panView so next movementX is relative
        panView = opts.getView();
        return;
      }
      if (dragStart) {
        const r = area.getBoundingClientRect();
        const svgR = svg.getBoundingClientRect();
        const curX = e.clientX - r.left;
        const x1 = Math.max(svgR.left - r.left, Math.min(dragStart.left, curX));
        const x2 = Math.min(svgR.right - r.left, Math.max(dragStart.left, curX));
        if (x2 - x1 > 4) { overlay.style.display = "block"; overlay.style.left = x1 + "px"; overlay.style.top = "0"; overlay.style.width = (x2 - x1) + "px"; overlay.style.height = svgR.height + "px"; }
        return;
      }
      if (!_interacting && !_animating) _updateTip(e);
    };

    const _onDocMouseUp = (e) => {
      if (panning) {
        panning = false;
        _interacting = false;
        panView = null;
        area.style.cursor = (e.shiftKey || e.altKey) ? 'grab' : 'crosshair';
        return;
      }
      if (!dragStart) return;
      const dx = Math.abs(e.clientX - dragStart.x);
      overlay.style.display = "none";
      _interacting = false;
      if (dx > 8) {
        const view = opts.getView();
        const f1 = pxToFrac(Math.min(dragStart.x, e.clientX));
        const f2 = pxToFrac(Math.max(dragStart.x, e.clientX));
        const toLo = view.startIdx + f1 * (view.endIdx - view.startIdx);
        const toHi = view.startIdx + f2 * (view.endIdx - view.startIdx);
        if (toHi - toLo >= 1) {
          // Animated zoom (TB-style)
          _animateZoom(view.startIdx, view.endIdx, toLo, toHi, view.totalLen);
        }
      }
      dragStart = null;
    };

    // Remove previous listeners if re-wiring the same area
    if (area._ciCleanup) area._ciCleanup();
    document.addEventListener("mousemove", _onDocMouseMove);
    document.addEventListener("mouseup", _onDocMouseUp);
    area._ciCleanup = () => {
      document.removeEventListener("mousemove", _onDocMouseMove);
      document.removeEventListener("mouseup", _onDocMouseUp);
      document.removeEventListener('keydown', _onKeyDown);
      document.removeEventListener('keyup', _onKeyUp);
    };

    // TB: Alt+wheel to zoom; plain scroll shows hint (3s timer)
    area.addEventListener("wheel", (e) => {
      const shouldZoom = !e.ctrlKey && !e.shiftKey && e.altKey;
      if (!shouldZoom) {
        _showZoomHint();
        return;
      }
      e.preventDefault();
      const view = opts.getView();
      if (view.totalLen <= 2) return;
      // TB deltaMode handling (line_chart_interactive_utils.ts)
      let scrollDeltaFactor = 1;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) scrollDeltaFactor = 8;
      else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) scrollDeltaFactor = 20;
      const scrollMagnitude = e.deltaY * scrollDeltaFactor;
      // TB: clip zoom-in to -0.95 to avoid inverting extent
      const zoomFactor = scrollMagnitude < 0
        ? Math.max(scrollMagnitude * SCROLL_ZOOM_SPEED_FACTOR, -0.95)
        : scrollMagnitude * SCROLL_ZOOM_SPEED_FACTOR;
      // Cursor-centered zoom (TB getProposedViewExtentOnZoom)
      const frac = pxToFrac(e.clientX);
      const range = view.endIdx - view.startIdx;
      const newLo = view.startIdx - frac * range * zoomFactor;
      const newHi = view.endIdx + (1 - frac) * range * zoomFactor;
      if (newHi - newLo >= view.totalLen * 0.995) {
        opts.zoomReset();
      } else if (newHi - newLo >= minRange) {
        const clamped = clampRange(newLo, newHi, view.totalLen);
        opts.setRange(clamped.lo, clamped.hi);
      }
    }, { passive: false });

    if (allowDoubleClickReset) {
      area.addEventListener("dblclick", (e) => {
        e.preventDefault();
        opts.zoomReset();
      });
    }

    function _updateTip(e) {
      const r = svg.getBoundingClientRect();
      const ar = area.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        tooltip.style.display = "none"; crosshair.style.display = "none"; return;
      }
      const view = opts.getView();
      const frac = (e.clientX - r.left) / r.width;
      const rawIdx = view.startIdx + frac * (view.endIdx - view.startIdx);
      // Snap mode: round to nearest data point. Free mode: keep fractional for interpolation.
      const snap = typeof opts.getSnap === 'function' ? opts.getSnap() : true;
      const dataIdx = snap
        ? Math.max(0, Math.min(Math.max(0, view.totalLen - 1), Math.round(rawIdx)))
        : Math.max(0, Math.min(Math.max(0, view.totalLen - 1), rawIdx));
      const xPos = e.clientX - ar.left;
      crosshair.style.display = "block"; crosshair.style.left = xPos + "px";

      // Bottom-anchored tooltip, clamped horizontally
      tooltip.style.display = "block";
      const tipW = tooltip.offsetWidth || 120;
      let tipLeft = xPos - tipW / 2;
      tipLeft = Math.max(4, Math.min(tipLeft, ar.width - tipW - 4));
      tooltip.style.left = tipLeft + "px";
      tooltip.style.bottom = "4px";
      tooltip.style.top = "";

      if (opts.formatTip) {
        const tip = opts.formatTip(dataIdx, frac);
        tooltip.innerHTML = tip;
      } else {
        tooltip.textContent = '#' + (snap ? dataIdx : dataIdx.toFixed(1));
      }
      if (opts.onHover) opts.onHover(dataIdx);
    }

    area.addEventListener("mouseleave", () => {
      if (!_interacting) {
        tooltip.style.display = "none";
        crosshair.style.display = "none";
        if (opts.onLeave) opts.onLeave();
      }
    });
  }

  return { wire, findClosestIndex: _findClosestIndex };
})();
