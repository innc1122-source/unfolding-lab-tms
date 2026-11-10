import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { setTitleLang } from './brand.js';

// UI-chrome dictionary. Values may be strings or interpolation functions —
// this mirrors the existing public/i18n.js model so the full dictionary can be
// ported in later. Course/exam CONTENT stays bilingual via `_zh` fields + loc().
const DICT = {
  zh: {
    navHome: '首页', navLearningGroup: '培训', navLearning: '我的课程', navRecord: '成长档案', navReview: '绩效评估', logout: '退出登录', changePw: '修改密码', cancel: '取消', adminConsole: '人才管理后台',
    // 手机底栏短标签（IA 1.3；读屏用 navRecord / navReview 全称）与页头模块路径的无障碍名称（IA 1.4）
    tabRecord: '成长档案', tabReview: '绩效', trailLabel: '当前位置',
    language: '语言', switchLang: '切换语言', account: '账户', primaryNav: '主导航',
    hi: '你好，',
    metaModMin: (m, min) => `${m} 模块 · 约 ${min} 分钟`,
    score: (s) => `成绩 ${s}%`,
  },
  en: {
    navHome: 'Home', navLearningGroup: 'Learning', navLearning: 'My Courses', navRecord: 'Development Record', navReview: 'Performance Reviews', logout: 'Sign out', changePw: 'Change password', cancel: 'Cancel', adminConsole: 'Talent Console',
    // Phone tab-bar short labels (IA 1.3; screen readers get navRecord / navReview) and the page-trail landmark name (IA 1.4)
    tabRecord: 'Records', tabReview: 'Performance', trailLabel: 'You are here',
    language: 'Language', switchLang: 'Switch language', account: 'Account', primaryNav: 'Primary navigation',
    hi: 'Hi, ',
    metaModMin: (m, min) => `${m} modules · ~${min} min`,
    score: (s) => `Score ${s}%`,
  },
};

const I18nCtx = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    // Precedence: ?lang= deep-link -> saved choice -> browser language (Chinese
    // browsers default to zh; everyone else — incl. the Filipino workforce — to en).
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'en' || q === 'zh') return q;
    const saved = localStorage.getItem('lms-lang');
    if (saved === 'en' || saved === 'zh') return saved;
    return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  });

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    // The tab title is chrome too: re-render it in the new language (brand.js
    // keeps the last brand block applyBrand saw).
    setTitleLang(lang);
  }, [lang]);

  const setLang = useCallback((l) => { localStorage.setItem('lms-lang', l); setLangState(l); }, []);
  const toggle = useCallback(() => setLang(lang === 'zh' ? 'en' : 'zh'), [lang, setLang]);

  const t = useCallback((key, ...args) => {
    const v = DICT[lang][key] ?? DICT.en[key] ?? key;
    return typeof v === 'function' ? v(...args) : v;
  }, [lang]);

  // Localized content field: obj[field] (en) or obj[field + '_zh'] (zh).
  // CX-036（2026-10-09 验收）：缺哪种语言就回退另一种 —— 英文留空显示中文、中文留空显示英文；课程编辑器保存时不再把中文复制进英文。
  const loc = useCallback((obj, field) => {
    const en = obj[field], zh = obj[field + '_zh'];
    const has = (v) => v != null && v !== '';
    if (lang === 'zh') return has(zh) ? zh : en;
    return has(en) ? en : (has(zh) ? zh : en);
  }, [lang]);

  return <I18nCtx.Provider value={{ lang, setLang, toggle, t, loc }}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
