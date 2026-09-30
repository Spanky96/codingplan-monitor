'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var telecomjs = require('../src/telecomjs');

test('seven-day average only counts days with consumption', function() {
    var entries = [0, 0, 0, 0, 0, 318.95, 463.67].map(function(consumption, index) {
        return {
            date: '2026-07-' + String(10 + index).padStart(2, '0'),
            data: { timeRangeConsumption: consumption }
        };
    });

    var summary = telecomjs._summarizeDailyCosts(entries);

    assert.equal(summary.todayConsumption, 463.67);
    assert.equal(summary.yesterdayConsumption, 318.95);
    assert.equal(summary.sevenDayConsumption, 782.62);
    assert.equal(summary.consumptionRangeDays, 2);
    assert.equal(summary.averageDailyConsumption, 391.31);
});

test('seven-day average is zero when no daily consumption is available', function() {
    var summary = telecomjs._summarizeDailyCosts([
        { date: '2026-07-14', data: {} },
        { date: '2026-07-15', data: {} },
        { date: '2026-07-16', data: { timeRangeConsumption: 0 } }
    ]);

    assert.equal(summary.todayConsumption, 0);
    assert.equal(summary.yesterdayConsumption, 0);
    assert.equal(summary.consumptionRangeDays, 0);
    assert.equal(summary.averageDailyConsumption, 0);
});

// 模拟天翼登录页 DOM：未勾选时勾上「一周内自动登录」
test('markWeekAutoLoginCheckbox checks unlabeled week-auto-login box', function() {
    var mark = telecomjs._markWeekAutoLoginCheckbox;
    assert.equal(typeof mark, 'function');

    // 极简 document stub
    var checkbox = {
        type: 'checkbox',
        checked: false,
        disabled: false,
        id: 'autoLogin',
        click: function() { this.checked = true; },
        closest: function() { return null; },
        getAttribute: function() { return null; },
        parentElement: {
            textContent: '一周内自动登录',
            querySelector: function() { return checkbox; }
        },
        nextElementSibling: { textContent: '一周内自动登录' },
        previousElementSibling: null,
        matches: function(sel) { return sel === 'input[type="checkbox"]'; },
        dispatchEvent: function() { return true; }
    };
    var label = {
        textContent: '一周内自动登录',
        querySelector: function(sel) {
            return sel === 'input[type="checkbox"]' ? checkbox : null;
        }
    };
    global.document = {
        querySelectorAll: function(sel) {
            if (sel === 'input[type="checkbox"]') return [checkbox];
            if (sel.indexOf('label') === 0 || sel.indexOf('label,') === 0) return [label];
            return [];
        },
        querySelector: function(sel) {
            if (sel.indexOf('label[for=') === 0) return label;
            return null;
        }
    };
    global.Event = function(type) { this.type = type; };

    try {
        var ok = mark();
        assert.equal(ok, true);
        assert.equal(checkbox.checked, true);
    } finally {
        delete global.document;
        delete global.Event;
    }
});

test('markWeekAutoLoginCheckbox is no-op when already checked', function() {
    var mark = telecomjs._markWeekAutoLoginCheckbox;
    var checkbox = {
        type: 'checkbox',
        checked: true,
        disabled: false,
        id: '',
        click: function() { throw new Error('should not click'); },
        closest: function() {
            return { textContent: '一周内自动登录' };
        },
        getAttribute: function() { return null; },
        parentElement: { textContent: '一周内自动登录' },
        nextElementSibling: null,
        previousElementSibling: null,
        dispatchEvent: function() { return true; }
    };
    global.document = {
        querySelectorAll: function(sel) {
            if (sel === 'input[type="checkbox"]') return [checkbox];
            return [];
        },
        querySelector: function() { return null; }
    };
    global.Event = function(type) { this.type = type; };
    try {
        assert.equal(mark(), true);
        assert.equal(checkbox.checked, true);
    } finally {
        delete global.document;
        delete global.Event;
    }
});
