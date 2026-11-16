'use strict';

function splitCapacity(ids, total, result) {
    ids.forEach((id, i) => { result[id] = Math.floor(total / ids.length) + (i < total % ids.length ? 1 : 0); });
}
function allocateBackupCapacity({ rows, assessment, previous, telemetry, config, now, hasPrimary }) {
    const enabled = !hasPrimary || assessment.active;
    const required = !enabled ? 0 : hasPrimary
        ? Math.max(1, assessment.capacityGap || Math.ceil(assessment.capacity * (assessment.fraction || 0.15)))
        : Math.max(2, Math.ceil(assessment.demand / 0.85));
    let remaining = required;
    const paid = rows.filter(r => r.role === 'paid' && r.raw > 0 && !r.limited && r.nativeChannels && config.allowPaid);
    const backup = rows.filter(r => r.role !== 'paid' && r.raw > 0 && !r.limited && r.fallbackChannels && config.allowDilution);
    for (const r of rows.filter(r => r.role === 'paid' || r.fallbackChannels)) {
        const live = telemetry[r.name] || {}, old = previous[r.name] || {};
        const ids = Object.keys(r.channelModes || {});
        const native = ids.filter(id => r.channelModes[id] === 'native');
        const recovering = r.limited || (r.lastLimitedAt && now-r.lastLimitedAt<120000);
        // A reserve with ample quota must be usable when the primary pool is
        // already short of capacity. Forecast pacing alone would otherwise park
        // the reserve precisely when it is needed. Actual near-exhaustion and
        // upstream rate limits still constrain it.
        r.backupQuotaOverride = !!(enabled && config.allowDilution && assessment.capacityGap > 0 &&
            r.role === 'standard' && r.fallbackChannels && r.raw > 0 && r.effectiveMode !== 'slow' &&
            r.shortUsed != null && r.shortUsed < 85 && (r.weeklyUsed == null || r.weeklyUsed < 95));
        const quotaLimit = r.backupQuotaOverride ? r.maxConcurrency : r.shortProtection === 2 ? 1 : r.shortProtection === 1 ? 2 : r.maxConcurrency;
        const limit = Math.min(r.maxConcurrency, recovering ? r.concurrency : r.maxConcurrency,
            quotaLimit);
        const nativeUse = (live.channels || []).filter(c => r.channelModes[String(c.id)] === 'native').reduce((n,c) => n+(c.current||0),0);
        r.nativeCapacity = r.role === 'paid' || !(r.raw > 0) ? 0 : Math.min(limit, Math.max(native.length || r.nativeChannels, Math.ceil(nativeUse / 0.8)));
        r.backupCapacity = 0;
        r.backupCeiling = Math.max(0, limit - r.nativeCapacity);
        r.backupAdjustedAt = old.backupAdjustedAt || 0;
    }
    for (const r of paid.concat(backup)) {
        if (!enabled || remaining <= 0) continue;
        const old = previous[r.name] || {}, live = telemetry[r.name] || {};
        const mode = r.role === 'paid' ? 'native' : 'fallback';
        const channels = (live.channels || []).filter(c => r.channelModes[String(c.id)] === mode);
        const occupied = channels.reduce((n,c) => n+(c.current||0),0);
        const observedCapacity = channels.filter(c => c.enabled && c.weight > 0).reduce((n,c) => n+(c.capacity||0),0);
        const before = old.backupCapacity == null ? observedCapacity : old.backupCapacity;
        const canGrow = !old.backupAdjustedAt || now - old.backupAdjustedAt >= (r.role === 'paid' ? 60000 : 30000);
        // Paid capacity probes two slots first and grows on real use. Replacement
        // capacity fills the remaining deficit, without reserving idle aliases an equal share.
        const probe = !before ? 2 : before + (canGrow && (r.role !== 'paid' || occupied >= before * 0.75) ? (r.role === 'paid' ? 1 : 2) : 0);
        r.backupCapacity = Math.min(remaining, r.backupCeiling, probe);
        if (r.backupCapacity !== before) r.backupAdjustedAt = now;
        remaining -= r.backupCapacity;
    }
    for (const r of rows.filter(r => r.backupCapacity != null)) {
        const modes = r.channelModes || {}, map = Object.fromEntries(Object.keys(modes).map(id => [id,0]));
        splitCapacity(Object.keys(modes).filter(id => modes[id] === 'native'), r.role === 'paid' ? r.backupCapacity : r.nativeCapacity, map);
        splitCapacity(Object.keys(modes).filter(id => modes[id] === 'fallback'), r.role === 'paid' ? 0 : r.backupCapacity, map);
        r.channelConcurrency = map;
        r.concurrency = Math.max(1, r.nativeCapacity + r.backupCapacity);
        r.reasons = r.reasons.filter(reason => !reason.startsWith('并发 '));
        if (r.role === 'paid') {
            if (!r.backupCapacity && r.raw > 0) { r.raw = 0; r.state = r.limited ? 'cooldown' : 'standby'; r.reasons = [r.limited ? '上游限流，暂停按量兜底' : '按量渠道待命']; }
            else if (r.backupCapacity) { r.state = 'fallback'; r.reasons.push('按量兜底并发 ' + r.backupCapacity + '/' + r.maxConcurrency); }
        } else {
            if (!r.nativeCapacity && !r.backupCapacity && r.raw > 0) { r.raw = 0; r.state = 'standby'; r.reasons = ['备用分流待命']; }
            else {
                if (r.backupQuotaOverride && r.backupCapacity > 0 && !r.limited) {
                    if (r.state === 'protecting') r.state = 'balanced';
                    r.reasons = r.reasons.filter(reason => !reason.startsWith('按官方近期消耗速度') && !reason.startsWith('5 小时额度偏紧'));
                    r.reasons.push('主力并发不足，备用余量充足，优先承接当前缺口');
                }
                r.reasons.push('原生并发 ' + r.nativeCapacity + '，备用并发 ' + r.backupCapacity + '；共用上限 ' + r.maxConcurrency);
            }
        }
    }
    return { required, allocated: required-remaining, shortfall: remaining,
        paid: paid.reduce((n,r)=>n+r.backupCapacity,0), fallback: backup.reduce((n,r)=>n+r.backupCapacity,0) };
}

function assignBackupWeights(rows, assessment, capacity, hasPrimary) {
    const primary = rows.filter(r => r.role === 'primary' && r.nativeChannels);
    const primaryWeight = primary.reduce((n,r)=>n+r.weight,0);
    const active = rows.filter(r => r.backupCapacity > 0 && r.weight > 0);
    const total = active.reduce((n,r)=>n+r.backupCapacity,0);
    const ratio = Math.max(assessment.fraction || 0.15, assessment.capacityGap > 0 ? Math.max(0,assessment.demand-assessment.capacity) / Math.max(1,assessment.capacity) : 0);
    const largest = Math.max(1,...active.map(r=>r.backupCapacity));
    const targets = active.map(r => ({r,value:hasPrimary ? primaryWeight*ratio*r.backupCapacity/Math.max(1,total) : 10*r.backupCapacity/largest,
        ceiling:r.role!=='paid'&&r.nativeCapacity>0?9.8:10}));
    const scale = Math.min(1,...targets.map(t=>t.value>0?t.ceiling/t.value:1));
    if (scale<1) primary.forEach(r=>{r.weight=r.weight>0?Math.max(0.1,Math.floor(r.weight*scale*10)/10):0;});
    for (const r of rows) {
        const target = targets.find(t=>t.r===r);
        const weight = target ? Math.floor(target.value*scale*10)/10 : 0;
        if (r.role==='paid') {
            r.nativeWeight=weight;r.fallbackWeight=0;r.weight=weight;
        } else if (r.backupCapacity != null) {
            r.fallbackWeight=weight;
            r.nativeWeight=r.nativeCapacity>0?Math.round(Math.max(0.2,r.weight-weight)*10)/10:0;
            r.weight=Math.round((r.nativeWeight+r.fallbackWeight)*10)/10;
        } else { r.nativeWeight=r.nativeChannels?r.weight:0;r.fallbackWeight=0; }
        // A disabled route never exports a positive capacity under the v2 extension.
        if (r.channelConcurrency) Object.keys(r.channelConcurrency).forEach(id=>{
            if (!(r.channelModes[id]==='native'?r.nativeWeight:r.fallbackWeight)) r.channelConcurrency[id]=0;
        });
        if (r.channelConcurrency && Object.keys(r.channelConcurrency).length) r.concurrency=Math.max(1,Object.values(r.channelConcurrency).reduce((n,v)=>n+v,0));
    }
}
module.exports = { allocateBackupCapacity, assignBackupWeights };
