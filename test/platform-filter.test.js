var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

function createFilterContext() {
    var writes = [];
    var context = {
        _filterPlatforms: [],
        _sortMode: 'default',
        _viewMode: 'block',
        weightsMap: {},
        capacityMap: {},
        accountsData: [],
        document: {
            querySelectorAll: function() { return []; },
            getElementById: function() { return null; }
        },
        localStorage: {
            setItem: function(key, value) { writes.push([key, value]); }
        }
    };
    vm.createContext(context);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../public/js/app/cards.js'), 'utf8'),
        context
    );
    context.storageWrites = writes;
    return context;
}

test('platform filters combine multiple selected providers and persist toggles', function() {
    var context = createFilterContext();
    var accounts = [
        { platform: 'glm', name: 'glm' },
        { platform: 'yescode', name: 'yescode' },
        { platform: 'zenmux', name: 'zenmux' }
    ];

    context.setFilter('yescode');
    context.setFilter('zenmux');
    assert.deepEqual(Array.from(context._filterPlatforms), ['yescode', 'zenmux']);
    assert.deepEqual(
        Array.from(context.applyFilterSort(accounts), function(item) { return item.acc.platform; }),
        ['yescode', 'zenmux']
    );
    assert.deepEqual(context.storageWrites.at(-1), [
        'usage_platform_filters',
        JSON.stringify(['yescode', 'zenmux'])
    ]);

    context.setFilter('yescode');
    assert.deepEqual(Array.from(context._filterPlatforms), ['zenmux']);

    context.setFilter('all');
    assert.deepEqual(Array.from(context._filterPlatforms), []);
    assert.equal(context.applyFilterSort(accounts).length, 3);
});
