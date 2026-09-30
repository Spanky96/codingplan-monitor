'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-weights-'));
var accountsFile = path.join(fixtureDir, 'accounts.json');
var cacheFile = path.join(fixtureDir, 'usage-cache.json');

fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [
    { name: 'Coding A', platform: 'glm', isPublic: true },
    { name: 'Telecom A', platform: 'telecomjs', isPublic: true }
] }));
fs.writeFileSync(cacheFile, JSON.stringify({
    0: {
        time: Date.now(),
        result: {
            name: 'Coding A',
            platform: 'glm',
            success: true,
            cachedAt: Date.now(),
            data: { limits: [{ unit: 3, percentage: 0 }] }
        }
    },
    1: {
        time: Date.now(),
        result: {
            name: 'Telecom A',
            platform: 'telecomjs',
            success: true,
            cachedAt: Date.now(),
            data: {
                balance: 90,
                platformGiftBalance: 0,
                sevenDayConsumption: 2,
                consumptionRangeDays: 2
            }
        }
    }
}));

process.env.ACCOUNTS_FILE = accountsFile;
process.env.USAGE_CACHE_FILE = cacheFile;
process.env.ADMIN_PASSWORD = 'test-password';

var registerApi = require('../src/api');

function captureRoutes() {
    var routes = {};
    var app = {};
    ['get', 'post', 'put', 'delete'].forEach(function(method) {
        app[method] = function(route) {
            routes[method + ' ' + route] = Array.prototype.slice.call(arguments, 1);
        };
    });
    registerApi(app);
    return routes;
}

test('weights API includes computed Telecom weight and detail', function() {
    var routes = captureRoutes();
    var handler = routes['get /api/weights'][0];
    var response;
    var realNow = Date.now;
    Date.now = function() { return Date.UTC(2026, 6, 16, 7, 0); }; // 15:00 CST
    try {
        handler(
            { query: { password: 'test-password', detail: '1' } },
            {
                json: function(body) { response = body; },
                status: function() { return this; },
                set: function() { return this; }
            }
        );
    } finally {
        Date.now = realNow;
    }

    assert.equal(response.weights['Coding A'], 6);
    assert.equal(response.weights['Telecom A'], 10);
    var detail = response.detail.find(function(item) { return item.name === 'Telecom A'; });
    assert.equal(detail.platform, 'telecomjs');
    assert.equal(detail.remainingDays, 90);
    assert.equal(detail.capacityScore, 6);
    assert.equal(detail.codingAverage, 6);
    assert.equal(detail.codingPressure, 1);
    assert.equal(detail.timeMultiplier, 2);
    assert.equal(detail.peak, true);
    assert.equal(detail.base, 12);
});
