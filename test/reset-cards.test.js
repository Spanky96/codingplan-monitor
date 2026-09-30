'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'test-password';

var parseGlmResetCards = require('../src/api')._parseGlmResetCards;

// 用户提供的真实响应结构(Spanky_yym 账号,1 张周重置卡)
var REAL_RESPONSE = {
    customerId: 89451768371237240,
    targetType: 'PERSONAL',
    organizationId: null,
    projectId: null,
    lastFiveHourResetTime: null,
    lastWeekResetTime: null,
    fiveHourResets: [],
    weekResets: [
        { recordId: 14276, expireTime: '2026-09-03 23:59:59', available: true }
    ]
};

test('real response with one available weekly card parses to one card', function() {
    var cards = parseGlmResetCards(REAL_RESPONSE);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0], { type: 'week', recordId: 14276, expireTime: '2026-09-03 23:59:59' });
});

test('only available cards are counted', function() {
    var cards = parseGlmResetCards({
        fiveHourResets: [
            { recordId: 1, expireTime: '2026-08-25 23:59:59', available: true },
            { recordId: 2, expireTime: '2026-08-20 23:59:59', available: false }
        ],
        weekResets: [
            { recordId: 3, expireTime: '2026-09-03 23:59:59', available: true }
        ]
    });
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0], { type: 'fiveHour', recordId: 1, expireTime: '2026-08-25 23:59:59' });
    assert.deepEqual(cards[1], { type: 'week', recordId: 3, expireTime: '2026-09-03 23:59:59' });
});

test('all-unavailable cards yield empty list', function() {
    var cards = parseGlmResetCards({
        fiveHourResets: [{ recordId: 1, expireTime: '2026-08-20 23:59:59', available: false }],
        weekResets: []
    });
    assert.deepEqual(cards, []);
});

test('missing expireTime falls back to null instead of undefined', function() {
    var cards = parseGlmResetCards({
        weekResets: [{ recordId: 1, available: true }]
    });
    assert.deepEqual(cards, [{ type: 'week', recordId: 1, expireTime: null }]);
});

test('missing recordId falls back to null instead of undefined', function() {
    var cards = parseGlmResetCards({
        weekResets: [{ expireTime: '2026-09-03 23:59:59', available: true }]
    });
    assert.deepEqual(cards, [{ type: 'week', recordId: null, expireTime: '2026-09-03 23:59:59' }]);
});

test('null / empty / malformed data is tolerated', function() {
    assert.deepEqual(parseGlmResetCards(null), []);
    assert.deepEqual(parseGlmResetCards({}), []);
    assert.deepEqual(parseGlmResetCards({ weekResets: null, fiveHourResets: 'bad' }), []);
    assert.deepEqual(parseGlmResetCards({ weekResets: [null, { available: true }] }).length, 1);
});
