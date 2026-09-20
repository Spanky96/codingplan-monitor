// 通用小工具:数字补零(minimax 与阶跃的日期/时长格式化共用)。
function pad2(n) { return n.length < 2 ? '0' + n : n; }

module.exports = { pad2: pad2 };
