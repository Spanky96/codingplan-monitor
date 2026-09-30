'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var weights = require('../src/weights');

var SEVEN_DAYS_MS = 7 * 86400000;
// 周期已过 40%，周用量 80% → 明显超前且会提前耗尽至少 1 天
var NOW = Date.UTC(2026, 6, 17, 6, 0, 0); // 2026-07-17 06:00 UTC
var WEEKLY_RESET = NOW + (SEVEN_DAYS_MS * 0.6); // 还剩 60% 周期

function glmResult(overrides) {
    var base = {
        platform: 'glm',
        success: true,
        teamEdition: undefined,
        data: {
            limits: [
                { type: 'TOKENS_LIMIT', unit: 3, percentage: 20, nextResetTime: NOW + 3600000 },
                { type: 'TOKENS_LIMIT', unit: 6, percentage: 80, nextResetTime: WEEKLY_RESET }
            ]
        }
    };
    return Object.assign({}, base, overrides || {}, {
        data: Object.assign({}, base.data, (overrides && overrides.data) || {})
    });
}

test('personal coding plan with high weekly usage needs reset', function() {
    var rec = weights.getGLMResetRecommendation(glmResult(), NOW);
    assert.ok(rec);
    assert.equal(rec.needed, true);
    assert.equal(rec.weeklyPct, 80);
    assert.ok(rec.unavailableHours >= 24);
});

test('JWT ENTERPRISE / personalEdition=false still qualifies when not teamEdition', function() {
    // 个人订阅账号的 JWT 常为 ENTERPRISE；不得因此屏蔽「需要重置」
    var rec = weights.getGLMResetRecommendation(glmResult({
        personalEdition: false
    }), NOW);
    assert.ok(rec);
    assert.equal(rec.needed, true);
});

test('explicit teamEdition accounts are excluded', function() {
    var rec = weights.getGLMResetRecommendation(glmResult({
        teamEdition: true,
        personalEdition: true
    }), NOW);
    assert.equal(rec, null);
});

test('exhausted weekly quota is not recommended for reset', function() {
    var rec = weights.getGLMResetRecommendation(glmResult({
        data: {
            limits: [
                { type: 'TOKENS_LIMIT', unit: 6, percentage: 99.95, nextResetTime: WEEKLY_RESET }
            ]
        }
    }), NOW);
    assert.equal(rec, null);
});

test('low weekly usage does not trigger reset badge', function() {
    var rec = weights.getGLMResetRecommendation(glmResult({
        data: {
            limits: [
                { type: 'TOKENS_LIMIT', unit: 6, percentage: 50, nextResetTime: WEEKLY_RESET }
            ]
        }
    }), NOW);
    assert.equal(rec, null);
});

test('near official reset does not trigger reset badge', function() {
    var almostReset = NOW + 12 * 3600000; // 仅剩 12 小时
    var rec = weights.getGLMResetRecommendation(glmResult({
        data: {
            limits: [
                { type: 'TOKENS_LIMIT', unit: 6, percentage: 90, nextResetTime: almostReset }
            ]
        }
    }), NOW);
    assert.equal(rec, null);
});

test('non-glm platforms are ignored', function() {
    var rec = weights.getGLMResetRecommendation({
        platform: 'yescode',
        data: { limits: [] }
    }, NOW);
    assert.equal(rec, null);
});
