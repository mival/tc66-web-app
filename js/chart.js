// Small canvas strip chart: one series, time on the x axis.
(function (globalScope) {
  'use strict';

  const PADDING_LEFT = 52;
  const PADDING_RIGHT = 20;
  const PADDING_TOP = 24;
  const PADDING_BOTTOM = 18;

  // Return a step of 1, 2 or 5 times a power of ten that gives about targetTickCount ticks.
  function niceStep(range, targetTickCount) {
    const roughStep = range / Math.max(1, targetTickCount);
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const normalized = roughStep / magnitude;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return factor * magnitude;
  }

  function formatTime(totalSeconds) {
    totalSeconds = Math.round(totalSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  // options: { times, values (arrays), timeStart, timeEnd, color, unit, decimals, label }
  function drawStrip(canvas, options) {
    const pixelRatio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    }
    const context = canvas.getContext('2d');
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const style = getComputedStyle(canvas);
    const gridColor = style.getPropertyValue('--chart-grid').trim() || '#8884';
    const textColor = style.getPropertyValue('--chart-text').trim() || '#888';

    const plotWidth = width - PADDING_LEFT - PADDING_RIGHT;
    const plotHeight = height - PADDING_TOP - PADDING_BOTTOM;
    const { times, values, color, unit, decimals = 2, label } = options;

    context.font = `11px ${style.fontFamily}`;
    context.fillStyle = textColor;
    context.textBaseline = 'top';
    context.fillText(label, PADDING_LEFT, 2);

    const timeStart = options.timeStart;
    const timeEnd = options.timeEnd > timeStart ? options.timeEnd : timeStart + 1;

    // Value range from the visible points.
    let valueMin = Infinity;
    let valueMax = -Infinity;
    for (let i = 0; i < times.length; i++) {
      if (times[i] < timeStart || times[i] > timeEnd) continue;
      valueMin = Math.min(valueMin, values[i]);
      valueMax = Math.max(valueMax, values[i]);
    }
    if (!isFinite(valueMin)) {
      valueMin = 0;
      valueMax = 1;
    }
    if (valueMax - valueMin < 1e-6) {
      const margin = Math.max(Math.abs(valueMin) * 0.01, 0.01);
      valueMin -= margin;
      valueMax += margin;
    }
    const valueStep = niceStep(valueMax - valueMin, 4);
    const allValuesPositive = valueMin >= 0;
    valueMin = Math.floor(valueMin / valueStep) * valueStep;
    if (allValuesPositive) valueMin = Math.max(0, valueMin);
    valueMax = Math.ceil(valueMax / valueStep) * valueStep;

    const toPixelX = (time) => PADDING_LEFT + ((time - timeStart) / (timeEnd - timeStart)) * plotWidth;
    const toPixelY = (value) => PADDING_TOP + plotHeight - ((value - valueMin) / (valueMax - valueMin)) * plotHeight;

    // Grid and axis labels.
    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    context.textBaseline = 'middle';
    context.textAlign = 'right';
    const valueDecimals = Math.max(0, -Math.floor(Math.log10(valueStep)));
    for (let value = valueMin; value <= valueMax + valueStep / 2; value += valueStep) {
      const y = Math.round(toPixelY(value)) + 0.5;
      context.beginPath();
      context.moveTo(PADDING_LEFT, y);
      context.lineTo(PADDING_LEFT + plotWidth, y);
      context.stroke();
      context.fillText(`${value.toFixed(valueDecimals)} ${unit}`, PADDING_LEFT - 4, y);
    }
    context.textAlign = 'center';
    context.textBaseline = 'top';
    const timeStep = niceStep(timeEnd - timeStart, Math.max(2, Math.floor(plotWidth / 90)));
    for (let time = Math.ceil(timeStart / timeStep) * timeStep; time <= timeEnd; time += timeStep) {
      const x = Math.round(toPixelX(time)) + 0.5;
      context.beginPath();
      context.moveTo(x, PADDING_TOP);
      context.lineTo(x, PADDING_TOP + plotHeight);
      context.stroke();
      context.fillText(formatTime(time), x, PADDING_TOP + plotHeight + 3);
    }

    // Series line.
    context.save();
    context.beginPath();
    context.rect(PADDING_LEFT, PADDING_TOP, plotWidth, plotHeight);
    context.clip();
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.lineJoin = 'round';
    context.beginPath();
    let lineStarted = false;
    for (let i = 0; i < times.length; i++) {
      if (times[i] < timeStart - timeStep || times[i] > timeEnd + timeStep) continue;
      const x = toPixelX(times[i]);
      const y = toPixelY(values[i]);
      if (lineStarted) {
        context.lineTo(x, y);
      } else {
        context.moveTo(x, y);
        lineStarted = true;
      }
    }
    context.stroke();
    context.restore();

    // Last value.
    if (values.length) {
      context.textAlign = 'right';
      context.fillStyle = color;
      context.textBaseline = 'top';
      context.fillText(`${values[values.length - 1].toFixed(decimals)} ${unit}`, PADDING_LEFT + plotWidth, 2);
    }
  }

  globalScope.Chart = { drawStrip, formatTime };
})(globalThis);
