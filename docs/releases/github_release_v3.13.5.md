# v3.13.5 — 地图选点确认崩溃修复（v3.13.4 回归）

## 问题

v3.13.4 引入的"拍摄地点名称兜底"逻辑存在回归：地图选点后点击**确认位置**，弹出 `Uncaught TypeError: nameVal.trim is not a function (20-map.js:503)`，选点结果无法填入表单。

## 根因

搜索/逆地理返回的 `name`/`address` 字段在个别响应形态下**不是字符串**（如 Nominatim 的本地化名映射对象、AMap 的空数组字段）。v3.13.4 新增的兜底代码假设其恒为字符串并直接调用 `.trim()`，遇到非字符串类型即抛 TypeError。

## 修复

- 新增 `mapFieldToStr()` 类型收敛：字符串原样、对象提取首个非空字符串值（优先 zh/en）、其余 `String()`；
- 应用于 `mapSelectedLocation` 的全部赋值咽喉点（搜索结果选择、逆地理回写）与 `confirmMapSelection` 消费点，名称兜底与地址首段推导逻辑不变；
- 回归断言入库：`scripts/frontend-gate/_verify_meta_reuse_flows.js` 新增 2 条非字符串类型断言（对象名取本地化值 / 数字名收敛），全量 19/19 通过。

## 验证

- 门禁 01–09 全绿（07 36/36、08 12/12）；复用链路 jsdom 19/19。
