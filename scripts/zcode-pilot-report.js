#!/usr/bin/env node
'use strict';

// Read-only pilot evidence. Run from the repository/app root; stdout is JSON.
// Also supports: docker exec -i -w /app codingplan-monitor node < scripts/zcode-pilot-report.js
const path = require('node:path');
const root = process.cwd();
process.env.DOTENV_CONFIG_QUIET = 'true';
require(path.join(root, 'node_modules/dotenv')).config({ quiet: true });
const config = require(path.join(root, 'src/config'));
const { readAccounts } = require(path.join(root, 'src/api/accounts'));

async function json(url, headers) {
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('http_' + response.status);
    const result = await response.json();
    if (result.code != null && ![0, 200].includes(Number(result.code))) throw new Error('upstream_rejected');
    return result;
}

(async function() {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const report = { observedAt: new Date().toISOString(), day, benefitVerified: false,
        note: 'Hourly official aggregates may lag and mix pre/post-switch traffic. Rates are observations, not proof of campaign eligibility.', accounts: [] };
    const accounts = readAccounts();
    for (let index = 0; index < accounts.length; index++) {
        const account = accounts[index];
        if ((account.platform || 'glm') !== 'glm' || account.zcode?.enabled !== true) continue;
        const row = { index, name: account.name };
        try {
            const headers = { authorization: account.authorization, 'bigmodel-organization': account.organization, 'bigmodel-project': account.project };
            const query = new URLSearchParams({ type: '1', usageType: 'MODEL', startTime: day + ' 00:00:00', endTime: day + ' 23:59:59' });
            const [status, quota, detail] = await Promise.all([
                json('http://127.0.0.1:' + config.port + '/api/zcode/status/' + index, { 'X-Auth-Password': config.adminPassword }),
                json('https://bigmodel.cn/api/monitor/usage/quota/limit', headers),
                json('https://bigmodel.cn/api/monitor/credit-usage/usage-detail?' + query, headers)
            ]);
            row.status = status;
            row.quota = quota.data;
            const usage = detail.data?.modelUsage || {};
            row.officialUsage = detail.data;
            row.hourlyRates = (usage.modelDataList || []).flatMap(model => (usage.xTime || []).flatMap((hour, i) => {
                const outputTokens = Number(model.outputTokensUsage?.[i] || 0);
                if (!outputTokens) return [];
                const outputCredits = Number(model.outputCreditsUsage?.[i] || 0);
                return [{ model: model.modelCode, hour, outputTokens, outputCredits,
                    outputCreditsPerMillion: outputCredits > 0 ? Math.round(outputCredits / outputTokens * 1e6 * 100) / 100 : null }];
            }));
        } catch (err) {
            row.error = /^http_\d+$|^upstream_rejected$/.test(err.message) ? err.message : 'observation_unavailable';
        }
        report.accounts.push(row);
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(() => { process.stderr.write('zcode_report_failed\n'); process.exitCode = 1; });
