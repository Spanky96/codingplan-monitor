// 通用小工具:数字补零(minimax 与阶跃的日期/时长格式化共用)。
function pad2(n) { return n.length < 2 ? '0' + n : n; }

function beijingMidnight(ms) {
    const offset = 8 * 3600000, day = 86400000;
    return Math.floor((ms + offset) / day) * day - offset;
}

module.exports = { pad2, beijingMidnight };
