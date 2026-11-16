'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
test('more than twenty historical models retain chromatic stable colors', () => {
    const saved = new Map(); let dark = false;
    const context = { document: { documentElement: { classList: { contains: () => dark } } },
        localStorage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) } };
    vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app/relay.js'), 'utf8'), context);
    for (let i = 0; i < 80; i++) assert.notEqual(context.activityModelColor('model-' + i), context.ACTIVITY_MODEL_GRAY);
    const color = context.activityModelColor('claude-new-family');
    assert.equal(color, context.activityModelColor('CLAUDE-NEW-FAMILY'));
    dark = true; assert.notEqual(context.activityModelColor('claude-new-family'), color);
    assert.equal(context.activityModelColor(''), context.ACTIVITY_MODEL_GRAY);
});
