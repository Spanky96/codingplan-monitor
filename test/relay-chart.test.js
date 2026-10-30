'use strict';

/* 今日中转用量折线图(public/js/app/relay-chart.js):
 * - relayChartSeries:稀疏小时行透视后,系列活动范围内缺口补 0(折线连续),
 *   范围之外保持 null(线不向空时段延伸);记录 firstHour/lastHour 供缩放窗口用
 * - relayChartZoomWindow:默认缩放窗口贴合选中系列活动范围,首尾各留 1 小时,
 *   越界钳制到 0-23,无有效小时退回全天
 * vm 桩上下文加载脚本(顶层仅依赖 window.addEventListener)。 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

function createChartContext() {
    var context = {
        escapeHtml: function (s) { return s; },
        activityDisplayName: function (r) { return 'user-' + r.user_id; },
        window: { addEventListener: function () {} }
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../public/js/app/relay-chart.js'), 'utf8'),
        context
    );
    return context;
}

test('系列活动范围内的缺口补 0,范围之外保持 null', function () {
    var c = createChartContext();
    c._relayChartState.mode = 'model';
    c._relayChartState.metric = 'tokens';
    var list = c.relayChartSeries({ rows: [
        { hour: 9, user_id: 1, model: 'glm-5.3', requests: 2, total_tokens: 200 },
        { hour: 13, user_id: 1, model: 'glm-5.3', requests: 3, total_tokens: 300 }
    ]});

    assert.equal(list.length, 1);
    assert.equal(list[0].firstHour, 9);
    assert.equal(list[0].lastHour, 13);
    var v = list[0].values;
    assert.equal(v[8], null);    // 活动范围之前:断开,不向空凌晨延伸
    assert.equal(v[9], 200);
    assert.equal(v[10], 0);      // 范围内缺口:补 0,折线连续
    assert.equal(v[12], 0);
    assert.equal(v[13], 300);
    assert.equal(v[14], null);   // 活动范围之后:断开
    assert.equal(list[0].total, 500);
});

test('同键同小时多行聚合不受补 0 影响,显式 0 行计入活动范围', function () {
    var c = createChartContext();
    c._relayChartState.mode = 'model';
    c._relayChartState.metric = 'tokens';
    var list = c.relayChartSeries({ rows: [
        { hour: 9, user_id: 1, model: 'm', requests: 1, total_tokens: 100 },
        { hour: 9, user_id: 2, model: 'm', requests: 1, total_tokens: 50 },
        { hour: 11, user_id: 1, model: 'm', requests: 0, total_tokens: 0 }
    ]});

    assert.equal(list.length, 1);
    assert.equal(list[0].values[9], 150);
    assert.equal(list[0].values[10], 0);
    assert.equal(list[0].values[11], 0);
    assert.equal(list[0].lastHour, 11);
    assert.equal(list[0].total, 150);
});

test('按用户模式按 user_id 分组,补 0 同样生效', function () {
    var c = createChartContext();
    c._relayChartState.mode = 'user';
    c._relayChartState.metric = 'requests';
    var list = c.relayChartSeries({ rows: [
        { hour: 10, user_id: 1, model: 'm', requests: 4, total_tokens: 400 },
        { hour: 12, user_id: 1, model: 'm', requests: 2, total_tokens: 200 }
    ]});

    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'user-1');
    assert.equal(list[0].values[10], 4);
    assert.equal(list[0].values[11], 0);
    assert.equal(list[0].values[12], 2);
});

test('默认缩放窗口贴合活动范围并首尾各留 1 小时', function () {
    var c = createChartContext();
    var mk = function (first, last) { return { label: 'm', firstHour: first, lastHour: last }; };

    assert.deepEqual(Array.from(c.relayChartZoomWindow([mk(8, 20)])), [7, 21]);
    assert.deepEqual(Array.from(c.relayChartZoomWindow([mk(0, 23)])), [0, 23]);              // 全天:钳制不加余量
    assert.deepEqual(Array.from(c.relayChartZoomWindow([mk(0, 12), mk(5, 23)])), [0, 23]);
    assert.deepEqual(Array.from(c.relayChartZoomWindow([mk(5, 5)])), [4, 6]);                // 单小时
    assert.deepEqual(Array.from(c.relayChartZoomWindow([{ label: 'm', firstHour: -1, lastHour: -1 }])), [0, 23]);
});

test('默认窗口忽略未选中系列(用户模式默认只画前 5 名)', function () {
    var c = createChartContext();
    var list = [
        { label: 'a', firstHour: 9, lastHour: 15 },
        { label: 'b', firstHour: 3, lastHour: 20 }
    ];
    var isSelected = function (s) { return s.label !== 'b'; };

    assert.deepEqual(Array.from(c.relayChartZoomWindow(list, isSelected)), [8, 16]);
});
