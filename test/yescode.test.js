var test = require('node:test');
var assert = require('node:assert/strict');

var yescode = require('../src/api/platforms/yescode');

test('401 triggers YesCode login, persists the new cookie, and retries', async function() {
    var account = {
        cookie: 'expired',
        yescode_username: 'user@example.com',
        yescode_password: 'secret'
    };
    var requests = 0;
    var saved = null;
    var result = await yescode.withYescodeAuthRetry(account, 3, async function(current) {
        requests++;
        if (current.cookie === 'expired') throw new Error('HTTP 401: unauthorized');
        return { data: { email: 'user@example.com' } };
    }, {
        login: async function(email, password) {
            assert.equal(email, 'user@example.com');
            assert.equal(password, 'secret');
            return 'yescode_auth=fresh';
        },
        saveCookie: function(index, cookie) { saved = { index: index, cookie: cookie }; }
    });

    assert.equal(requests, 2);
    assert.equal(account.cookie, 'yescode_auth=fresh');
    assert.deepEqual(saved, { index: 3, cookie: 'yescode_auth=fresh' });
    assert.equal(result.data.email, 'user@example.com');
});

test('non-authentication errors do not trigger login', async function() {
    var loginCalled = false;
    await assert.rejects(function() {
        return yescode.withYescodeAuthRetry({
            cookie: 'current',
            yescode_username: 'user@example.com',
            yescode_password: 'secret'
        }, 0, async function() {
            throw new Error('HTTP 500: upstream unavailable');
        }, {
            login: async function() { loginCalled = true; }
        });
    }, /HTTP 500/);
    assert.equal(loginCalled, false);
});

test('profile email extraction ignores profile username', function() {
    assert.equal(yescode.getYescodeProfileEmail({
        data: { email: ' user@example.com ', username: 'display-name' }
    }), 'user@example.com');
    assert.equal(yescode.getYescodeProfileEmail({ data: { username: 'display-name' } }), '');
});

test('profile email replaces and persists a historical profile username', function() {
    var account = {
        yescode_username: 'display-name',
        yescode_password: 'secret'
    };
    var saved = null;
    var changed = yescode.syncYescodeLoginEmail(account, 7, {
        data: { email: 'user@example.com', username: 'display-name' }
    }, function(index, patch) {
        saved = { index: index, patch: patch };
        return true;
    });

    assert.equal(changed, true);
    assert.equal(account.yescode_username, 'user@example.com');
    assert.deepEqual(saved, {
        index: 7,
        patch: { yescode_username: 'user@example.com' }
    });
});
