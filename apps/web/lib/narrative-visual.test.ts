import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chartOrientation, deltaTone, formatValue, isTimeAxis, niceTicks, sparkPath, trendColor, waterfallBars, wrapLabel, GOOD, BAD,
} from './narrative-visual';

describe('formatValue', () => {
  it('writes each format in its own unit', () => {
    assert.equal(formatValue(1164.56, 'usd_m'), '$1,164.6M');
    assert.equal(formatValue(1164.56, 'usd_m', { compact: true }), '$1.16bn');
    assert.equal(formatValue(3.52, 'percent'), '3.5%');
    assert.equal(formatValue(0.6, 'pp', { signed: true }), '+0.6 pp');
    assert.equal(formatValue(626.9, 'bps'), '627 bps');
    assert.equal(formatValue(1.3, 'multiple'), '1.30x');
    assert.equal(formatValue(-6.9, 'usd_m', { signed: true }), '-$6.9M');
    assert.equal(formatValue(463, 'number'), '463');
  });

  it('leaves text and blanks alone', () => {
    assert.equal(formatValue('', 'usd_m'), '');
    assert.equal(formatValue('n/a', 'usd_m'), 'n/a');
  });
});

describe('niceTicks', () => {
  it('uses clean steps that cover the data', () => {
    assert.deepEqual(niceTicks(0, 31), [0, 10, 20, 30, 40]);
    const t = niceTicks(1163.9, 1182.6);
    assert.ok(t[0] <= 1163.9 && t[t.length - 1] >= 1182.6);
    assert.ok(t.every((v, i) => i === 0 || Math.abs(v - t[i - 1] - (t[1] - t[0])) < 1e-9));
  });
});

describe('wrapLabel', () => {
  it('breaks on words instead of squeezing, and marks a cut', () => {
    assert.deepEqual(wrapLabel('Real Estate', 12), ['Real Estate']);
    assert.deepEqual(wrapLabel('Net investment income', 12), ['Net', 'investment…']);
    assert.deepEqual(wrapLabel('Transportation', 8, 1), ['Transpo…']);
  });
});

describe('delta direction', () => {
  it('colours a change by whether that direction is good for the measure', () => {
    assert.equal(deltaTone(0.4), 'good');
    assert.equal(deltaTone(0.4, 'down'), 'bad');
    assert.equal(deltaTone('-0.5 pts'), 'bad');
    assert.equal(deltaTone('-1.2x', 'down'), 'good');
    assert.equal(deltaTone(0), 'flat');
    assert.equal(trendColor('up', 'down'), BAD);
    assert.equal(trendColor('down', 'down'), GOOD);
  });
});

describe('sparkPath', () => {
  it('draws a series inside its box and returns the last point', () => {
    const p = sparkPath([1, 3, 2], 60, 20)!;
    assert.match(p.d, /^M2\.0,18\.0 L30\.0,2\.0 L58\.0,10\.0$/);
    assert.equal(p.last.x, 58);
    assert.equal(sparkPath([5], 60, 20), null);
  });
});

describe('waterfallBars', () => {
  it('walks from a start total through each step to an end total', () => {
    const bars = waterfallBars([100, 10, -4, 0], [0, 3]);
    assert.deepEqual(bars.map((b) => [b.from, b.to, b.kind]), [[0, 100, 'total'], [100, 110, 'up'], [110, 106, 'down'], [0, 106, 'total']]);
  });
});

describe('chartOrientation', () => {
  it('runs names horizontally, keeps time left to right, and turns a crowded waterfall', () => {
    assert.equal(chartOrientation({ chartType: 'bar', labels: ['Software', 'Financials', 'Media', 'Energy', 'Healthcare', 'Real Estate', 'Telecom'] }), 'horizontal');
    assert.equal(chartOrientation({ chartType: 'bar', labels: ['2027', '2028', '2029', '2030', '2031', '2032', '2033'] }), 'vertical');
    assert.equal(chartOrientation({ chartType: 'bar', labels: ['First', 'Second'] }), 'vertical');
    assert.equal(chartOrientation({ chartType: 'waterfall', labels: Array.from({ length: 14 }, (_, i) => `Step ${i}`) }), 'horizontal');
    assert.equal(chartOrientation({ chartType: 'line', labels: ['a', 'b'] }), 'vertical');
    assert.equal(chartOrientation({ chartType: 'bar', labels: ['A very long borrower name'], orientation: 'vertical' }), 'vertical');
    assert.equal(isTimeAxis(['Nov-25', 'Dec-25', 'Q1 2026']), true);
  });
});
