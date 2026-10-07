import zh from './zh.json';
import enJson from './en.json';

export type Lang = 'zh' | 'en';
export type Dict = typeof zh;
// Typing en as Dict makes `astro check` fail when English is missing a key.
const en: Dict = enJson;

export const t = (lang: Lang): Dict => (lang === 'zh' ? zh : en);
/** English lives at the root, Chinese under /zh/ (same as yunshu.ai). */
export const pathFor = (lang: Lang): string => (lang === 'en' ? '/' : '/zh/');
