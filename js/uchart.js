// Interactive time charts built on uPlot. Each chart shows one series against elapsed time.
// The cursor shows the value at the mouse. Drag left or right to zoom. Double click resets.
// Several charts can share a cursor, so one hover shows the value on all of them.
(function (globalScope) {
  'use strict';

  const uPlot = globalScope.uPlot;

  function formatTime(totalSeconds) {
    totalSeconds = Math.round(totalSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  // Resolve a CSS value (var(), light-dark(), color-mix()) to a plain color for the canvas.
  let colorProbe = null;
  function resolveColor(cssValue) {
    if (!colorProbe) {
      colorProbe = document.createElement('span');
      colorProbe.style.display = 'none';
      document.body.append(colorProbe);
    }
    colorProbe.style.color = '';
    colorProbe.style.color = cssValue;
    return getComputedStyle(colorProbe).color;
  }

  // Make a translucent fill from an rgb() color.
  function translucent(rgbColor, alpha) {
    const match = rgbColor.match(/^rgba?\(([^)]+)\)/);
    if (!match) return rgbColor;
    const parts = match[1].split(',').slice(0, 3).map((p) => p.trim());
    return `rgba(${parts.join(', ')}, ${alpha})`;
  }

  function themeColors() {
    return { axis: resolveColor('var(--chart-text)'), grid: resolveColor('var(--chart-grid)') };
  }

  // Create a chart in `container`.
  // options: { label, unit, colorToken, decimals, height, sync (from UChart.sync), fontFamily }
  function create(container, options) {
    const { label, unit, colorToken, decimals = 2, height = 150, sync } = options;
    const theme = themeColors();
    const color = resolveColor(`var(${colorToken})`);
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const axisOptions = (values) => ({
      stroke: theme.axis,
      grid: { stroke: theme.grid, width: 1 },
      ticks: { stroke: theme.grid, width: 1 },
      font: `11px ${fontFamily}`,
      values,
    });

    const chart = new uPlot({
      width: Math.max(container.clientWidth || 600, 200),
      height,
      title: label,
      cursor: {
        sync: sync ? { key: sync.key, setSeries: true } : undefined,
        drag: { x: true, y: false },
        points: { size: 6 },
      },
      legend: { live: true },
      scales: { x: { time: false } },
      axes: [
        axisOptions((self, splits) => splits.map(formatTime)),
        { ...axisOptions((self, splits) => splits.map((v) => `${v} ${unit}`)), size: 62 },
      ],
      series: [
        { label: 'Time', value: (self, value) => (value == null ? '--' : formatTime(value)) },
        {
          label,
          stroke: color,
          width: 1.5,
          fill: translucent(color, 0.12),
          value: (self, value) => (value == null ? '--' : `${value.toFixed(decimals)} ${unit}`),
        },
      ],
    }, [[], []], container);

    const resizeObserver = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (width) chart.setSize({ width, height });
    });
    resizeObserver.observe(container);

    // A drag zooms in. Live updates then keep the zoom until a double click resets it.
    let zoomed = false;
    let updating = false;
    chart.over.addEventListener('mouseup', () => { if (chart.select.width > 0) zoomed = true; });
    chart.over.addEventListener('dblclick', () => { zoomed = false; });

    return {
      uplot: chart,
      setData(times, values) {
        chart.setData([times, values]);
      },
      // Show live data in a time window [windowStart, windowEnd]. Only the points in the window are drawn,
      // reduced to about maxPoints. While the user is zoomed in, the window does not move.
      setWindow(times, values, windowStart, windowEnd, maxPoints = 2000) {
        const visible = sliceWindow(times, values, windowStart);
        const reduced = decimate(visible.times, visible.values, maxPoints);
        updating = true;
        chart.setData([reduced.times, reduced.values], !zoomed);
        if (!zoomed) chart.setScale('x', { min: windowStart, max: Math.max(windowEnd, windowStart + 1) });
        updating = false;
      },
      get zoomed() { return zoomed && !updating; },
      destroy() {
        resizeObserver.disconnect();
        chart.destroy();
      },
    };
  }

  // Return the points from windowStart on. times is sorted, so a binary search finds the start.
  function sliceWindow(times, values, windowStart) {
    let low = 0;
    let high = times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (times[middle] < windowStart) low = middle + 1;
      else high = middle;
    }
    // Keep one point before the window, so the line starts at the left edge.
    const start = Math.max(0, low - 1);
    return { times: times.slice(start), values: values.slice(start) };
  }

  // Reduce a long series to about maxPoints. Each bucket keeps its lowest and highest point,
  // so short peaks stay visible.
  function decimate(times, values, maxPoints) {
    if (times.length <= maxPoints) return { times, values };
    const bucketSize = Math.ceil(times.length / (maxPoints / 2));
    const outTimes = [];
    const outValues = [];
    for (let start = 0; start < times.length; start += bucketSize) {
      const end = Math.min(start + bucketSize, times.length);
      let lowIndex = start;
      let highIndex = start;
      for (let i = start + 1; i < end; i++) {
        if (values[i] < values[lowIndex]) lowIndex = i;
        if (values[i] > values[highIndex]) highIndex = i;
      }
      const first = Math.min(lowIndex, highIndex);
      const second = Math.max(lowIndex, highIndex);
      outTimes.push(times[first]);
      outValues.push(values[first]);
      if (second !== first) {
        outTimes.push(times[second]);
        outValues.push(values[second]);
      }
    }
    return { times: outTimes, values: outValues };
  }

  globalScope.UChart = { create, formatTime, sliceWindow, decimate, sync: (key) => uPlot.sync(key) };
})(globalThis);
