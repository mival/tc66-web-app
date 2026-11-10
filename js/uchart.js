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

    return {
      uplot: chart,
      setData(times, values) {
        chart.setData([times, values]);
      },
      destroy() {
        resizeObserver.disconnect();
        chart.destroy();
      },
    };
  }

  globalScope.UChart = { create, formatTime, sync: (key) => uPlot.sync(key) };
})(globalThis);
