// Unfolding Lab 版：行为实践（3+3）模块已从本产品删除（2026-10-12）。
// 保留同名导出，让顶栏、首页的既有判断代码不用改：一律视为「模块不存在」，不发请求、不显示入口。
export const CULTURE_PAGE = '/culture/';
export const CULTURE_HR_PAGE = '/culture/#/hr';
export const CULTURE_DEPT_PAGE = '/culture/#/dept';
export const CULTURE_TEAM_PAGE = '/culture/#/team';
export function cultureOn() { return false; }
export function fetchCultureEntry() { return Promise.resolve(null); }
export function cultureEntryKind() { return null; }
export function cultureEntryHref() { return null; }
export function cultureNavShown() { return false; }
