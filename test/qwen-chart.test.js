'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'test-password';

var parseQwenModelUsageJson = require('../src/api')._parseQwenModelUsageJson;

function point(value, timestamp) {
    return { value: value, timestamp: timestamp };
}

function sumSeries(values, startTs, stepMs, usageType) {
    return {
        aggMethod: 'sum',
        metricName: 'model_usage',
        labels: { unit: 'tokens', usage_type: usageType },
        points: values.map(function(v, i) { return point(v, startTs + i * stepMs); })
    };
}

function okWrapper(originData) {
    return {
        code: '200',
        data: {
            DataV2: {
                ret: ['SUCCESS::接口调用成功'],
                data: { data: { originData: originData }, success: true, requestId: 'r-1' }
            },
            success: true,
            httpStatus: 200,
            errorCode: '',
            errorMsg: ''
        },
        successResponse: true
    };
}

test('千问曲线:时段内无调用(originData 空数组)返回空数据集而非报错', function() {
    var chart = parseQwenModelUsageJson(okWrapper([]));
    assert.deepEqual(chart, { x_time: [], modelDataList: [], totalUsage: { totalTokensUsage: 0 } });
});

test('千问曲线:成功结构但缺 originData 也按空数据处理', function() {
    var j = okWrapper([]);
    delete j.data.DataV2.data.data.originData;
    var chart = parseQwenModelUsageJson(j);
    assert.deepEqual(chart.x_time, []);
    assert.deepEqual(chart.modelDataList, []);
});

test('千问曲线:登录失效(无 DataV2 / success=false)抛 Cookie 提示', function() {
    var notLogined = {
        code: '200',
        data: {
            success: false,
            httpStatus: 200,
            errorCode: 'BailianGateway.Login.NotLogined',
            errorMsg: 'BailianGateway.Login.NotLogined'
        },
        successResponse: true
    };
    assert.throws(function() { parseQwenModelUsageJson(notLogined); }, /Cookie/);
    assert.throws(function() { parseQwenModelUsageJson({}); }, /Cookie/);
    assert.throws(function() { parseQwenModelUsageJson(null); }, /Cookie/);
});

test('千问曲线:过滤 cumsum 聚合序列,总用量不再翻倍', function() {
    var startTs = 1785391238000;
    var day = 86400000;
    var originData = [
        sumSeries([100, 200, 0], startTs, day, 'total_tokens'),
        // cumsum 周聚合:只有 1 个点,长度与 x 轴不一致 → 应被过滤
        {
            aggMethod: 'cumsum',
            metricName: 'model_usage',
            labels: { unit: 'tokens', usage_type: 'total_tokens' },
            points: [point(300, startTs + 2 * day)]
        },
        sumSeries([60, 140, 0], startTs, day, 'input_tokens')
    ];
    var chart = parseQwenModelUsageJson(okWrapper(originData));
    assert.equal(chart.x_time.length, 3);
    assert.deepEqual(chart.modelDataList.map(function(m) { return m.modelName; }), ['总Token', '输入Token']);
    assert.equal(chart.totalUsage.totalTokensUsage, 300);
});

test('千问曲线:web_search_count 翻译为「联网搜索」', function() {
    var startTs = 1785391238000;
    var chart = parseQwenModelUsageJson(okWrapper([sumSeries([2], startTs, 86400000, 'web_search_count')]));
    assert.equal(chart.modelDataList[0].modelName, '联网搜索');
});
